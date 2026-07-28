import { createReadStream } from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { readBoundedTextFile } from "../shared/path-safety.js";
import { serializeByKey } from "../shared/serialization.js";
import {
  decodeLineageEvent,
  decodeProvenanceSession,
  encodeLineageEvent,
  encodeProvenanceSession
} from "./codec.js";
import type { LineageEvent, ProvenanceSession } from "./models.js";
import { MAX_SESSION_BYTES, MAX_SESSION_FILES } from "./limits.js";
import { commitsMatch, compareEvents } from "./stable.js";

const locks = new Map<string, Promise<void>>();
const eventIndexCache = new Map<string, EventIndex>();

interface FileFingerprint {
  exists: boolean;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  inode: string;
}

interface EventIndexMetadata {
  version: 1;
  fingerprint: FileFingerprint;
  count: number;
}

interface EventIndex {
  fingerprint: FileFingerprint;
  ids: Set<string>;
}

async function fingerprint(path: string): Promise<FileFingerprint> {
  try {
    const value = await stat(path, { bigint: true });
    return {
      exists: true,
      size: String(value.size),
      mtimeNs: String(value.mtimeNs),
      ctimeNs: String(value.ctimeNs),
      inode: String(value.ino)
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, size: "0", mtimeNs: "0", ctimeNs: "0", inode: "0" };
    }
    throw error;
  }
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return (
    left.exists === right.exists &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.inode === right.inode
  );
}

async function readLines(path: string, visit: (line: string) => void): Promise<void> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) visit(line);
  } finally {
    lines.close();
    input.destroy();
  }
}

async function scanEventIds(path: string): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    await readLines(path, (line) => {
      if (!line.trim()) return;
      try {
        const event = decodeLineageEvent(JSON.parse(line) as unknown);
        if (event) ids.add(event.id);
      } catch {
        // Malformed legacy lines are ignored just as they are by events().
      }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return ids;
}

async function scanIndexedIds(path: string): Promise<Set<string>> {
  const ids = new Set<string>();
  await readLines(path, (line) => {
    const id = JSON.parse(line) as unknown;
    if (typeof id !== "string" || !id) throw new Error("Event ID index is invalid.");
    ids.add(id);
  });
  return ids;
}

async function flushDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicWrite(path: string, data: string | Buffer, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  );
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await flushDirectory(dirname(path));
}

export class ProvenanceStore {
  readonly provenanceDirectory: string;
  readonly eventsFile: string;
  readonly eventIdsFile: string;
  readonly eventIndexFile: string;
  readonly sessionsDirectory: string;

  constructor(readonly repoRoot: string) {
    this.provenanceDirectory = join(repoRoot, ".lineage", "provenance");
    this.eventsFile = join(this.provenanceDirectory, "events.jsonl");
    this.eventIdsFile = join(this.provenanceDirectory, "event-ids.jsonl");
    this.eventIndexFile = join(this.provenanceDirectory, "event-index.json");
    this.sessionsDirectory = join(this.provenanceDirectory, "sessions");
  }

  async ensureDirectories(): Promise<void> {
    await mkdir(this.sessionsDirectory, { recursive: true, mode: 0o700 });
  }

  async events(): Promise<LineageEvent[]> {
    let text: string;
    try {
      text = await readFile(this.eventsFile, "utf8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .flatMap((line) => {
        if (!line.trim()) return [];
        try {
          const event = decodeLineageEvent(JSON.parse(line) as unknown);
          return event ? [event] : [];
        } catch {
          return [];
        }
      })
      .sort(compareEvents);
  }

  readEvents(): Promise<LineageEvent[]> {
    return this.events();
  }

  async boundedEvents(
    maxEvents: number
  ): Promise<{ events: LineageEvent[]; truncated: boolean }> {
    const events: LineageEvent[] = [];
    let total = 0;
    try {
      await readLines(this.eventsFile, (line) => {
        if (!line.trim()) return;
        try {
          const event = decodeLineageEvent(JSON.parse(line) as unknown);
          if (!event) return;
          total += 1;
          events.push(event);
          if (events.length > maxEvents * 2) events.splice(0, maxEvents);
        } catch {
          // Malformed legacy lines are ignored.
        }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {
      events: events.slice(-maxEvents).sort(compareEvents),
      truncated: total > maxEvents
    };
  }

  async append(event: LineageEvent): Promise<"appended" | "duplicate"> {
    return serializeByKey(locks, this.eventsFile, async () => {
      await this.ensureDirectories();
      let index = await this.#eventIndex();
      let before = await fingerprint(this.eventsFile);
      if (!sameFingerprint(index.fingerprint, before)) {
        index = await this.#rebuildEventIndex();
        before = index.fingerprint;
      }
      if (index.ids.has(event.id)) return "duplicate";
      const line = `${JSON.stringify(encodeLineageEvent(event))}\n`;
      await appendFile(this.eventsFile, line, { encoding: "utf8", mode: 0o600, flush: true });
      const after = await fingerprint(this.eventsFile);
      const expectedSize = BigInt(before.size) + BigInt(Buffer.byteLength(line));
      const stableAppend =
        after.exists &&
        BigInt(after.size) === expectedSize &&
        (!before.exists || before.inode === after.inode);
      if (!stableAppend) {
        await this.#rebuildEventIndex();
        return "appended";
      }
      index.ids.add(event.id);
      await appendFile(this.eventIdsFile, `${JSON.stringify(event.id)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flush: true
      });
      await this.#writeEventIndexMetadata(after, index.ids.size);
      index.fingerprint = after;
      eventIndexCache.set(this.eventsFile, index);
      return "appended";
    });
  }

  async #eventIndex(): Promise<EventIndex> {
    const current = await fingerprint(this.eventsFile);
    const cached = eventIndexCache.get(this.eventsFile);
    if (cached && sameFingerprint(cached.fingerprint, current)) return cached;
    try {
      const metadata = JSON.parse(
        await readFile(this.eventIndexFile, "utf8")
      ) as EventIndexMetadata;
      if (
        metadata.version !== 1 ||
        !sameFingerprint(metadata.fingerprint, current)
      ) {
        return this.#rebuildEventIndex();
      }
      const ids = await scanIndexedIds(this.eventIdsFile);
      if (ids.size !== metadata.count) return this.#rebuildEventIndex();
      const index = { fingerprint: current, ids };
      eventIndexCache.set(this.eventsFile, index);
      return index;
    } catch {
      return this.#rebuildEventIndex();
    }
  }

  async #rebuildEventIndex(): Promise<EventIndex> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await fingerprint(this.eventsFile);
      const ids = await scanEventIds(this.eventsFile);
      const after = await fingerprint(this.eventsFile);
      if (!sameFingerprint(before, after)) continue;
      await atomicWrite(
        this.eventIdsFile,
        [...ids].map((id) => JSON.stringify(id)).join("\n") + (ids.size > 0 ? "\n" : ""),
        0o600
      );
      await this.#writeEventIndexMetadata(after, ids.size);
      const index = { fingerprint: after, ids };
      eventIndexCache.set(this.eventsFile, index);
      return index;
    }
    throw new Error("Events changed repeatedly while rebuilding the event ID index.");
  }

  async #writeEventIndexMetadata(
    eventsFingerprint: FileFingerprint,
    count: number
  ): Promise<void> {
    const metadata: EventIndexMetadata = {
      version: 1,
      fingerprint: eventsFingerprint,
      count
    };
    await atomicWrite(
      this.eventIndexFile,
      `${JSON.stringify(metadata, null, 2)}\n`,
      0o600
    );
  }

  async sessions(): Promise<ProvenanceSession[]> {
    let names: string[];
    try {
      names = await readdir(this.sessionsDirectory);
    } catch {
      return [];
    }
    const candidates = names
      .filter((name) => name.endsWith(".json"))
      .sort()
      .slice(0, MAX_SESSION_FILES);
    const sessions: Array<ProvenanceSession | undefined> = [];
    for (let index = 0; index < candidates.length; index += 32) {
      sessions.push(
        ...await Promise.all(
          candidates.slice(index, index + 32).map(async (name) => {
          try {
            const source = await readBoundedTextFile(
              join(this.sessionsDirectory, name),
              MAX_SESSION_BYTES
            );
            if (!source || source.truncated) return undefined;
            return decodeProvenanceSession(JSON.parse(source.text) as unknown);
          } catch {
            return undefined;
          }
          })
        )
      );
    }
    return sessions
      .filter((session): session is ProvenanceSession => Boolean(session))
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  readSessions(): Promise<ProvenanceSession[]> {
    return this.sessions();
  }

  async writeSession(session: ProvenanceSession): Promise<string> {
    await this.ensureDirectories();
    const safeProvider = session.provider.replaceAll(/[^A-Za-z0-9._-]/g, "_");
    const safeSession = session.sessionId.replaceAll(/[^A-Za-z0-9._-]/g, "_");
    const path = join(this.sessionsDirectory, `${safeProvider}-${safeSession}.json`);
    await serializeByKey(locks, path, () =>
      atomicWrite(path, `${JSON.stringify(encodeProvenanceSession(session), null, 2)}\n`)
    );
    return path;
  }

  async writeGeneratedJson(relativePath: string, value: unknown): Promise<string> {
    if (
      relativePath.startsWith("/") ||
      relativePath.split(/[\\/]/).some((part) => part === "..")
    ) {
      throw new Error("Generated output must stay inside the provenance directory.");
    }
    const path = join(this.provenanceDirectory, relativePath);
    await serializeByKey(locks, path, () =>
      atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`)
    );
    return path;
  }

  async matchingSessions(file: string, line: number, commitSha?: string): Promise<ProvenanceSession[]> {
    const sessions = await this.sessions();
    const direct = sessions.filter((session) =>
      session.lineRanges.some(
        (range) => range.file === file && line >= range.start && line <= range.end
      )
    );
    if (direct.length > 0) return direct;
    if (!commitSha || commitSha === "Unknown") return [];
    return sessions.filter(
      (session) =>
        Boolean(session.commitSha && commitsMatch(session.commitSha, commitSha)) &&
        (session.filesEdited.includes(file) || session.lineRanges.some((range) => range.file === file))
    );
  }

  async hasData(): Promise<boolean> {
    try {
      return (await stat(this.eventsFile)).size > 0 || (await this.sessions()).length > 0;
    } catch {
      return (await this.sessions()).length > 0;
    }
  }
}
