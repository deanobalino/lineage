import { describe, expect, it } from "vitest";

import {
  canonicalEventType,
  canonicalEvent,
} from "../../../src/domain/provider-adapters.js";

describe("provider adapters", () => {
  it("canonicalizes Codex camelCase aliases without losing native payload", () => {
    const event = canonicalEvent({
      provider: "codex",
      raw: {
        hookEventName: "PreToolUse",
        sessionId: "session-1",
        turnId: "turn-1",
      },
      payload: {
        toolName: "Bash",
        toolInput: {
          command: "npm test",
          future: { nested: [true, null, 4] },
        },
      },
      cwd: "/repo",
      repoRoot: "/repo",
      capturedAt: "2026-07-28T12:00:00Z",
      ingestionId: "event-1",
    });

    expect(event).toMatchObject({
      id: "event-1",
      provider: "codex",
      providerEventName: "PreToolUse",
      eventType: "pre_tool_use",
      sessionId: "session-1",
      turnId: "turn-1",
      payload: {
        tool_name: "Bash",
        tool_input: {
          command: "npm test",
          future: { nested: [true, null, 4] },
        },
      },
    });
  });

  it("preserves Copilot stop and session-end lifecycle differences", () => {
    expect(canonicalEventType("github-copilot", "Stop")).toBe("agent_stop");
    expect(canonicalEventType("github-copilot", "SessionEnd")).toBe(
      "session_stop",
    );
    expect(canonicalEventType("codex", "Stop")).toBe("session_stop");
  });
});
