import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  decodeLegacyEvent,
  decodeLegacySession,
  encodeLegacyEvent,
  encodeLegacySession,
} from "../../../src/domain/codec.js";

const fixtureRoot = fileURLToPath(
  new URL("../../fixtures/compatibility/", import.meta.url),
);

describe("legacy provenance models", () => {
  it("preserves recursive unknown provider payload values", async () => {
    const events = await readFile(
      `${fixtureRoot}/legacy/events.jsonl`,
      "utf8",
    );
    const promptLine = events
      .split("\n")
      .find((line) => line.includes('"event-legacy-prompt"'));

    expect(promptLine).toBeDefined();
    const event = decodeLegacyEvent(JSON.parse(promptLine!));

    expect(event?.payload["raw_provider_payload"]).toEqual({
      future_field: { nested: true },
    });
    expect(encodeLegacyEvent(event!)).toMatchObject({
      payload: {
        raw_provider_payload: {
          future_field: { nested: true },
        },
      },
    });
  });

  it("defaults historical session fields and retains unknown fields", async () => {
    const document = JSON.parse(
      await readFile(
        `${fixtureRoot}/legacy/sessions/codex-legacy-session.json`,
        "utf8",
      ),
    );

    const session = decodeLegacySession(document);

    expect(session?.provider).toBe("codex");
    expect(session?.providerDisplayName).toBe("Codex");
    expect(session?.commandsRun).toEqual([]);
    expect(session?.extra).toEqual({
      unknown_future_session_field: {
        preserved_by_fixture: true,
      },
    });
    expect(encodeLegacySession(session!)).toMatchObject({
      unknown_future_session_field: {
        preserved_by_fixture: true,
      },
    });
  });
});
