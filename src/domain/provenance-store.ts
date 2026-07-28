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
import { basename, dirname, join } from "node:path";
import {
  decodeLineageEvent,
  decodeProvenanceSession,
  encodeLineageEvent,
  encodeProvenanceSession
} from "./codec.js";
import type { LineageEvent, ProvenanceSession } from "./models.js";
import { commitsMatch, compareEvents } from "./stable.js";

const locks = new Map<string, Promise<void>>();

async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => current);
  locks.set(key, chain);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === chain) locks.delete(key);
  }
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
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
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
  readonly sessionsDirectory: string;

  constructor(readonly repoRoot: string) {
    this.provenanceDirectory = join(repoRoot, ".lineage", "provenance");
    this.eventsFile = join(this.provenanceDirectory, "events.jsonl");
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

  async append(event: LineageEvent): Promise<"appended" | "duplicate"> {
    return serialized(this.eventsFile, async () => {
      await this.ensureDirectories();
      if ((await this.events()).some((existing) => existing.id === event.id)) return "duplicate";
      const line = `${JSON.stringify(encodeLineageEvent(event))}\n`;
      await appendFile(this.eventsFile, line, { encoding: "utf8", mode: 0o600, flush: true });
      return "appended";
    });
  }

  async sessions(): Promise<ProvenanceSession[]> {
    let names: string[];
    try {
      names = await readdir(this.sessionsDirectory);
    } catch {
      return [];
    }
    const sessions = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          try {
            return decodeProvenanceSession(JSON.parse(await readFile(join(this.sessionsDirectory, name), "utf8")) as unknown);
          } catch {
            return undefined;
          }
        })
    );
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
    await serialized(path, () =>
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
    await serialized(path, () => atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`));
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
