import {
  appendFile,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeLegacySession,
  encodeLineageEvent,
} from "../../../src/domain/codec.js";
import type {
  LineageEvent,
  ProvenanceSession,
} from "../../../src/domain/models.js";
import {
  atomicWrite,
  ProvenanceStore,
} from "../../../src/domain/provenance-store.js";

const fixtureRoot = fileURLToPath(
  new URL("../../fixtures/compatibility/", import.meta.url),
);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true }),
    ),
  );
});

describe("ProvenanceStore", () => {
  it("reads valid JSONL in deterministic file order and skips malformed lines", async () => {
    const root = await materializeLegacyRepository();
    const store = new ProvenanceStore(root);

    const events = await store.readEvents();

    expect(events).toHaveLength(9);
    expect(events.map((event) => event.id)).toEqual([
      "event-legacy-start",
      "event-legacy-prompt",
      "event-legacy-tool",
      "event-legacy-options",
      "event-legacy-decision",
      "event-legacy-constraint",
      "event-legacy-stop",
      "event-copilot-stop",
      "event-copilot-end",
    ]);
  });

  it("decodes tolerant legacy sessions in deterministic identity order", async () => {
    const root = await materializeLegacyRepository();
    const store = new ProvenanceStore(root);

    const sessions = await store.readSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      provider: "codex",
      sessionId: "stored-legacy-session",
      commandsRun: [],
    });
  });

  it("serializes event appends and atomically replaces session and generated files", async () => {
    const root = await materializeLegacyRepository();
    const store = new ProvenanceStore(root);
    const legacyDocument = JSON.parse(
      await readFile(
        join(
          fixtureRoot,
          "legacy/sessions/codex-legacy-session.json",
        ),
        "utf8",
      ),
    );
    const baseSession = decodeLegacySession(legacyDocument);
    expect(baseSession).toBeDefined();
    const sessions = Array.from({ length: 8 }, (_, index): ProvenanceSession => ({
      ...baseSession!,
      sessionId: `session-${index}`,
      prompt: `prompt-${index}`,
    }));

    await Promise.all(sessions.map((session) => store.writeSession(session)));
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.writeGeneratedJson("generated/summary.json", {
          index,
          nested: { valid: true },
        }),
      ),
    );

    const stored = await store.readSessions();
    const generated = JSON.parse(
      await readFile(
        join(root, ".lineage/provenance/generated/summary.json"),
        "utf8",
      ),
    );
    expect(stored.map((session) => session.sessionId)).toEqual([
      "session-0",
      "session-1",
      "session-2",
      "session-3",
      "session-4",
      "session-5",
      "session-6",
      "session-7",
      "stored-legacy-session",
    ]);
    expect(generated).toMatchObject({
      nested: { valid: true },
    });
  });

  it("allows concurrent atomic replacements of the same file", async () => {
    const root = await mkdtemp(join(tmpdir(), "lineage-atomic-write-"));
    temporaryRoots.push(root);
    const target = join(root, "capture-health.json");

    const writes = await Promise.allSettled(
      Array.from({ length: 64 }, (_, index) =>
        atomicWrite(target, `${JSON.stringify({ index })}\n`),
      ),
    );

    expect(writes.filter((write) => write.status === "rejected")).toEqual([]);

    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
      index: expect.any(Number),
    });
  });

  it("uses and rebuilds the durable event ID index around external edits", async () => {
    const root = await materializeLegacyRepository();
    const store = new ProvenanceStore(root);
    const template = (await store.events())[0]!;
    const appended: LineageEvent = {
      ...template,
      id: "indexed-append",
      capturedAt: "2026-07-28T12:00:00.000Z",
    };
    const eventsSpy = vi.spyOn(store, "events").mockRejectedValue(
      new Error("append must not parse and sort the full event history"),
    );

    expect(await store.append(appended)).toBe("appended");
    expect(await store.append(appended)).toBe("duplicate");
    expect(eventsSpy).not.toHaveBeenCalled();
    expect(await readFile(store.eventIdsFile, "utf8")).toContain(
      JSON.stringify(appended.id),
    );

    const external: LineageEvent = {
      ...template,
      id: "external-edit",
      capturedAt: "2026-07-28T12:01:00.000Z",
    };
    await appendFile(
      store.eventsFile,
      `${JSON.stringify(encodeLineageEvent(external))}\n`,
      "utf8",
    );

    expect(await store.append(external)).toBe("duplicate");
    const afterExternal: LineageEvent = {
      ...template,
      id: "after-external-edit",
      capturedAt: "2026-07-28T12:02:00.000Z",
    };
    expect(await store.append(afterExternal)).toBe("appended");
    eventsSpy.mockRestore();
    expect((await store.events()).map((event) => event.id)).toEqual(
      expect.arrayContaining([
        appended.id,
        external.id,
        afterExternal.id,
      ]),
    );
    const page = await store.boundedEvents(2);
    expect(page.truncated).toBe(true);
    expect(page.events).toHaveLength(2);
  });
});

async function materializeLegacyRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lineage-domain-"));
  temporaryRoots.push(root);
  const provenance = join(root, ".lineage/provenance");
  const sessions = join(provenance, "sessions");
  await mkdir(sessions, { recursive: true });
  await cp(
    join(fixtureRoot, "legacy/events.jsonl"),
    join(provenance, "events.jsonl"),
  );
  await cp(
    join(
      fixtureRoot,
      "legacy/sessions/codex-legacy-session.json",
    ),
    join(sessions, "codex-stored-legacy-session.json"),
  );
  return root;
}
