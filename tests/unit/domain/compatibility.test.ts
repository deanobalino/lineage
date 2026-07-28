import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentTraceJsonl,
  agentTraceRecords,
  answerFollowUp,
  buildProvenanceGraph,
  decodeLineageEvent,
  explainLine,
  explanationMarkdown,
  linkEvents,
  loadSessionEvidence,
  ProvenanceStore,
  recoverCodexTranscripts,
  redact,
  sessionEvidenceJson,
  sessionEvidenceMarkdown,
  type GitLineEvidence,
  type LineageEvent,
  type ProvenanceSession
} from "../../../src/domain/index.js";

const fixtureRoot = fileURLToPath(
  new URL("../../fixtures/compatibility/", import.meta.url)
);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function fixtureEvents(): Promise<LineageEvent[]> {
  const text = await readFile(join(fixtureRoot, "legacy/events.jsonl"), "utf8");
  return text.split("\n").flatMap((line) => {
    try {
      const event = decodeLineageEvent(JSON.parse(line) as unknown);
      return event ? [event] : [];
    } catch {
      return [];
    }
  });
}

async function materialize(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lineage-compatibility-"));
  temporaryRoots.push(root);
  await mkdir(join(root, ".lineage/provenance/sessions"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await cp(
    join(fixtureRoot, "legacy/events.jsonl"),
    join(root, ".lineage/provenance/events.jsonl")
  );
  await cp(
    join(fixtureRoot, "legacy/sessions/codex-legacy-session.json"),
    join(root, ".lineage/provenance/sessions/codex-stored-legacy-session.json")
  );
  await writeFile(join(root, "src/retry.py"), "MAX_RETRIES = 5\nMAX_RETRIES = 7\n", "utf8");
  return root;
}

function gitEvidence(): GitLineEvidence {
  return {
    commitSha: "abc123",
    commitSummary: "Bound retries",
    author: "Dean",
    line: 2,
    content: "MAX_RETRIES = 7"
  };
}

describe("compatibility semantics", () => {
  it("reduces out-of-order input deterministically and respects provider finalization", async () => {
    const events = await fixtureEvents();
    const forward = linkEvents(events);
    const reverse = linkEvents([...events].reverse());

    expect(reverse).toEqual(forward);
    expect(forward.map((session) => `${session.provider}:${session.sessionId}`)).toEqual([
      "codex:legacy-session",
      "github-copilot:copilot-session"
    ]);

    const codex = forward[0]!;
    expect(codex).toMatchObject({
      prompt: "Keep retries bounded.",
      toolsUsed: ["Bash"],
      commandsRun: ["pytest tests/test_retry.py"],
      filesEdited: ["src/retry.py"],
      testsResult: "passed",
      lastAssistantMessage: "Implemented bounded retries."
    });
    expect(codex.decisions[0]).toMatchObject({
      kind: "user_selected_option",
      selectedOptionText: "Bounded retries",
      alternatives: [
        { id: "option-1", text: "Bounded retries" },
        { id: "option-2", text: "Retry forever" }
      ]
    });
    expect(codex.externalConstraints[0]).toMatchObject({
      filePath: "SPEC.md",
      startLine: 4,
      endLine: 8,
      summary: "Bounded retry requirement"
    });
    expect(codex.lineRanges).toEqual([
      {
        file: "src/retry.py",
        start: 1,
        end: 2,
        confidence: 0.92,
        label: "Recorded"
      }
    ]);

    const copilot = forward[1]!;
    expect(copilot.lastAssistantMessage).toBe("");
    expect(copilot.gitDiff).toBe("");
    expect(
      events.find((event) => event.id === "event-copilot-stop")?.eventType
    ).toBe("agent_stop");
    expect(
      events.find((event) => event.id === "event-copilot-end")?.eventType
    ).toBe("session_stop");
  });

  it("prefers provider sequence, then captured time and ingestion ID", () => {
    const base: LineageEvent = {
      id: "b",
      lineageSchemaVersion: "0.1",
      capturedAt: "2026-07-28T00:00:00.000Z",
      source: "provider-hook",
      provider: "codex",
      providerEventName: "UserPromptSubmit",
      eventType: "prompt",
      actor: "Codex",
      hookEventName: "UserPromptSubmit",
      sessionId: "ordered",
      payload: { prompt: "second" }
    };
    const events: LineageEvent[] = [
      { ...base, id: "a", providerSequence: 2, payload: { prompt: "second" } },
      { ...base, id: "z", providerSequence: 1, payload: { prompt: "first" } }
    ];
    expect(linkEvents(events)[0]?.prompt).toBe("second");
    const tied = events.map(({ providerSequence: _providerSequence, ...event }) => event);
    expect(linkEvents(tied)[0]?.prompt).toBe("first");
  });

  it("builds byte-stable graph identities with the 200-line expansion ceiling", async () => {
    const root = await materialize();
    const session = linkEvents(await fixtureEvents())[0]!;
    session.lineRanges = [
      { file: "src/retry.py", start: 1, end: 999, confidence: 0.7, label: "Recorded" }
    ];
    const graph = buildProvenanceGraph(root, [session], await fixtureEvents());
    const again = buildProvenanceGraph(root, [session], await fixtureEvents());

    expect(again).toEqual(graph);
    expect(graph.nodes.filter((node) => node.kind === "line")).toHaveLength(200);
    expect(graph.nodes.some((node) => node.kind === "decision")).toBe(true);
    expect(graph.nodes.some((node) => node.kind === "constraint")).toBe(true);
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(graph.nodes.length);
    expect(new Set(graph.edges.map((edge) => edge.id)).size).toBe(graph.edges.length);
  });

  it("redacts the frozen policy and loads provider transcript messages", async () => {
    const cases = JSON.parse(
      await readFile(join(fixtureRoot, "redaction/cases.json"), "utf8")
    ) as Array<{ id: string; input: string; expected: string }>;
    for (const item of cases) expect(redact(item.input), item.id).toBe(item.expected);

    const session = linkEvents(await fixtureEvents())[0]!;
    session.transcriptPath = join(fixtureRoot, "transcripts/codex-session.jsonl");
    const evidence = await loadSessionEvidence(session);

    expect(evidence.transcriptAvailable).toBe(true);
    expect(evidence.messages.map((message) => message.role)).toEqual([
      "user",
      "tool",
      "tool",
      "assistant"
    ]);
    expect(evidence.messages[0]?.body).toBe(
      "Use [REDACTED] while debugging."
    );
    expect(evidence.timeline.map((event) => event.group)).toContain("Decision");
    expect(evidence.timeline.map((event) => event.group)).toContain("Constraint");
    expect(evidence.timeline.every((event) => !event.id.match(/^[0-9a-f-]{36}$/i))).toBe(true);
  });

  it("uses direct ranges before commit fallback and produces bounded Git fallback", async () => {
    const root = await materialize();
    const store = new ProvenanceStore(root);
    const direct = linkEvents(await fixtureEvents())[0]!;
    direct.commitSha = "abc123456789";
    await store.writeSession(direct);
    const fallback: ProvenanceSession = {
      ...direct,
      sessionId: "commit-only",
      lineRanges: [],
      filesEdited: ["src/retry.py"]
    };
    await store.writeSession(fallback);

    expect((await store.matchingSessions("src/retry.py", 2, "abc123"))[0]?.sessionId).toBe(
      "legacy-session"
    );
    expect(await store.matchingSessions("other.py", 2, "abc123")).toEqual([]);

    const provider = explainLine({
      file: "src/retry.py",
      line: 2,
      lineText: "MAX_RETRIES = 7",
      sessions: [direct],
      gitEvidence: gitEvidence(),
      referencesCount: 2
    });
    expect(provider.confidence).toBe(0.96);
    expect(provider.answer).toContain("Codex provenance");
    expect(answerFollowUp("What evidence supports this?", provider)).toContain(
      "Original prompt"
    );

    const fallbackExplanation = explainLine({
      file: "src/retry.py",
      line: 2,
      lineText: "MAX_RETRIES = 7",
      sessions: [],
      gitEvidence: gitEvidence()
    });
    expect(fallbackExplanation.confidence).toBe(0.42);
    expect(fallbackExplanation.answer).toContain("Git history only");
  });

  it("exports redacted Markdown, JSON, and deterministic Agent Trace JSONL", async () => {
    const root = await materialize();
    const session = linkEvents(await fixtureEvents())[0]!;
    session.transcriptPath = join(fixtureRoot, "transcripts/codex-session.jsonl");
    const evidence = await loadSessionEvidence(session);
    const markdown = sessionEvidenceMarkdown(evidence);
    const json = sessionEvidenceJson(evidence);

    expect(markdown).toContain("# Lineage Session Evidence");
    expect(markdown).toContain("## Event Timeline");
    expect(markdown).not.toContain("super-secret-value");
    expect(JSON.parse(json)).toMatchObject({ sessionId: "legacy-session" });

    const explanation = explainLine({
      file: "src/retry.py",
      line: 2,
      lineText: "MAX_RETRIES = 7",
      sessions: [session],
      gitEvidence: gitEvidence()
    });
    expect(explanationMarkdown(explanation)).toContain("## Decision provenance");

    const records = await agentTraceRecords(
      root,
      [session],
      "1970-01-01T00:00:00.000Z"
    );
    const recordsAgain = await agentTraceRecords(
      root,
      [session],
      "1970-01-01T00:00:00.000Z"
    );
    expect(recordsAgain).toEqual(records);
    expect(records[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(agentTraceJsonl(records).endsWith("\n")).toBe(true);
  });

  it("recovers only repository-matched Codex transcripts from approved roots", async () => {
    const root = await materialize();
    const transcripts = join(root, "approved-transcripts");
    await mkdir(transcripts, { recursive: true });
    const fixture = await readFile(
      join(fixtureRoot, "transcripts/codex-session.jsonl"),
      "utf8"
    );
    await writeFile(
      join(transcripts, "matched.jsonl"),
      fixture.replace("/fixture/repo", root),
      "utf8"
    );
    await writeFile(
      join(transcripts, "wrong-repository.jsonl"),
      fixture
        .replace('"legacy-session"', '"wrong-session"')
        .replace("/fixture/repo", join(root, "elsewhere")),
      "utf8"
    );

    expect(await recoverCodexTranscripts(root, [transcripts])).toEqual({
      imported: 1,
      scanned: 2
    });
    expect(await recoverCodexTranscripts(root, [transcripts])).toEqual({
      imported: 0,
      scanned: 2
    });
    expect((await new ProvenanceStore(root).sessions()).map((session) => session.sessionId))
      .toContain("legacy-session");
  });
});
