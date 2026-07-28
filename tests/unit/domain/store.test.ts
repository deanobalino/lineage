import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { decodeLegacySession } from "../../../src/domain/codec.js";
import type { ProvenanceSession } from "../../../src/domain/models.js";
import { ProvenanceStore } from "../../../src/domain/provenance-store.js";

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
