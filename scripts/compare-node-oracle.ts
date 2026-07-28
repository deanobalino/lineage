#!/usr/bin/env node

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentTraceRecords,
  buildProvenanceGraph,
  compareEvents,
  decodeLineageEvent,
  decodeProvenanceSession,
  encodeLineageEvent,
  encodeProvenanceSession,
  linkEvents,
  loadSessionEvidence,
  redact,
  sessionEvidenceJson,
  sessionEvidenceMarkdown
} from "../src/domain/index.js";
import { codexHooks, copilotHooks } from "../src/capture/hooks.js";
import type { SessionEvidence } from "../src/domain/evidence.js";
import type {
  LineageEvent,
  ProvenanceSession
} from "../src/domain/models.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(repoRoot, "tests/fixtures/compatibility");
const args = process.argv.slice(2);
const oracleIndex = args.indexOf("--oracle");
const oraclePath =
  oracleIndex >= 0 && args[oracleIndex + 1]
    ? resolve(repoRoot, args[oracleIndex + 1]!)
    : join(repoRoot, "docs/parity/oracle/normalized.json");

function normalizeText(value: string, root: string, transcript: string): string {
  return value
    .replaceAll(transcript, "/fixture/transcripts/codex-session.jsonl")
    .replaceAll(root, "/fixture/repo")
    .replace(
      /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.000Z\b/g,
      "$1Z"
    )
    .replaceAll("\r\n", "\n")
    .trimEnd();
}

function normalizeValue(value: unknown, root: string, transcript: string): unknown {
  if (typeof value === "string") return normalizeText(value, root, transcript);
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item, root, transcript));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      normalizeValue(item, root, transcript)
    ])
  );
}

function sorted<T>(values: T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}

function evidenceProjection(value: Record<string, unknown>) {
  const messages = (value["messages"] ?? []) as Array<Record<string, unknown>>;
  const timeline = (value["timeline"] ?? []) as Array<Record<string, unknown>>;
  return {
    sessionId: value["sessionId"] ?? value["sessionID"],
    provider: value["provider"],
    source: value["source"],
    model: value["model"],
    permissionMode: value["permissionMode"],
    transcriptAvailable: value["transcriptAvailable"],
    prompt: value["prompt"],
    finalMessage: value["finalMessage"],
    toolsUsed: value["toolsUsed"],
    commandsRun: value["commandsRun"],
    permissionRequests: value["permissionRequests"],
    filesEdited: value["filesEdited"],
    lineRanges: value["lineRanges"],
    testsRun: value["testsRun"],
    testsResult: value["testsResult"],
    gitDiff: value["gitDiff"],
    messages: messages.map(({ id: _id, ...message }) => message),
    timeline: timeline.map(({ id: _id, ...event }) => event)
  };
}

function sessionProjection(value: Record<string, unknown>) {
  const decisions = (value["decisions"] ?? []) as Array<Record<string, unknown>>;
  const { unknown_future_session_field: _unknown, ...known } = value;
  return {
    ...known,
    decisions: decisions.map(({ id: _id, ...decision }) => decision)
  };
}

function graphProjection(value: {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
}) {
  const nodeKinds = Object.fromEntries(
    [...new Set(value.nodes.map((node) => String(node["kind"])))].sort().map((kind) => [
      kind,
      value.nodes.filter((node) => node["kind"] === kind).length
    ])
  );
  const edgeKinds = Object.fromEntries(
    [...new Set(value.edges.map((edge) => String(edge["kind"])))].sort().map((kind) => [
      kind,
      value.edges.filter((edge) => edge["kind"] === kind).length
    ])
  );
  const anchors = sorted(
    value.nodes
      .filter((node) =>
        ["file", "range", "line", "session", "turn", "prompt", "tool", "test", "decision", "constraint", "final_message"]
          .includes(String(node["kind"]))
      )
      .map((node) => ({
        kind: node["kind"],
        label: node["label"],
        filePath: node["filePath"] ?? node["file_path"],
        startLine: node["startLine"] ?? node["start_line"],
        endLine: node["endLine"] ?? node["end_line"],
        sessionId: node["sessionId"] ?? node["session_id"],
        turnId: node["turnId"] ?? node["turn_id"],
        provider: node["provider"]
      })),
    (node) => JSON.stringify(node)
  );
  return { nodeKinds, edgeKinds, anchors };
}

function traceProjection(records: Array<Record<string, unknown>>) {
  return records.map((record) => {
    const files = (record["files"] ?? []) as Array<Record<string, unknown>>;
    return {
      version: record["version"],
      timestamp: record["timestamp"],
      vcs: record["vcs"],
      tool: {
        name: (record["tool"] as Record<string, unknown> | undefined)?.["name"]
      },
      files: files.map((file) => ({
        path: file["path"],
        conversations: (
          (file["conversations"] ?? []) as Array<Record<string, unknown>>
        ).map((conversation) => ({
          url: conversation["url"],
          contributor: conversation["contributor"],
          ranges: (
            (conversation["ranges"] ?? []) as Array<Record<string, unknown>>
          ).map(({ content_hash: _hash, ...range }) => range),
          related: conversation["related"]
        }))
      })),
      lineage: (
        (record["metadata"] as Record<string, unknown> | undefined)?.[
          "dev.lineage"
        ] as Record<string, unknown> | undefined
      )
    };
  });
}

function equal(left: unknown, right: unknown): boolean {
  return firstDifference(left, right) === undefined;
}

function firstDifference(
  left: unknown,
  right: unknown,
  path = "$"
): string | undefined {
  if (Object.is(left, right)) return undefined;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return `${path}: array length ${left.length} != ${right.length}`;
    }
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstDifference(left[index], right[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return undefined;
  }
  if (
    left &&
    right &&
    typeof left === "object" &&
    typeof right === "object"
  ) {
    const leftObject = left as Record<string, unknown>;
    const rightObject = right as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(leftObject), ...Object.keys(rightObject)])].sort();
    for (const key of keys) {
      if (!(key in leftObject)) return `${path}.${key}: missing from replacement`;
      if (!(key in rightObject)) return `${path}.${key}: missing from oracle`;
      const difference = firstDifference(
        leftObject[key],
        rightObject[key],
        `${path}.${key}`
      );
      if (difference) return difference;
    }
    return undefined;
  }
  if (typeof left === "string" && typeof right === "string") {
    let index = 0;
    while (
      left[index] === right[index] &&
      index < left.length &&
      index < right.length
    ) {
      index += 1;
    }
    return `${path}: strings differ at ${index}; ${JSON.stringify(left.slice(Math.max(0, index - 60), index + 100))} != ${JSON.stringify(right.slice(Math.max(0, index - 60), index + 100))}`;
  }
  return `${path}: ${JSON.stringify(left)?.slice(0, 160)} != ${JSON.stringify(right)?.slice(0, 160)}`;
}

async function fixtureEvents(): Promise<LineageEvent[]> {
  const text = await readFile(join(fixtureRoot, "legacy/events.jsonl"), "utf8");
  return text
    .split("\n")
    .flatMap((line) => {
      try {
        const event = decodeLineageEvent(JSON.parse(line) as unknown);
        return event ? [event] : [];
      } catch {
        return [];
      }
    })
    .sort(compareEvents);
}

const temporary = await mkdtemp(join(tmpdir(), "lineage-node-oracle-"));
try {
  await mkdir(join(temporary, "src"), { recursive: true });
  await writeFile(
    join(temporary, "src/retry.py"),
    "MAX_RETRIES = 5\nMAX_RETRIES = 7\n"
  );
  const transcript = join(temporary, "codex-session.jsonl");
  await cp(join(fixtureRoot, "transcripts/codex-session.jsonl"), transcript);

  const oracle = JSON.parse(await readFile(oraclePath, "utf8")) as Record<
    string,
    unknown
  >;
  const events = await fixtureEvents();
  const linked = linkEvents(events);
  const legacy = linked.find((session) => session.sessionId === "legacy-session")!;
  legacy.transcriptPath = transcript;
  const stored = decodeProvenanceSession(
    JSON.parse(
      await readFile(
        join(fixtureRoot, "legacy/sessions/codex-legacy-session.json"),
        "utf8"
      )
    ) as unknown
  )!;
  const sessions = sorted([...linked, stored], (session) =>
    `${session.provider}\0${session.sessionId}`
  );
  const graph = await buildProvenanceGraph(temporary, sessions, events);
  const evidence = await loadSessionEvidence(legacy);
  const traces = await agentTraceRecords(
    temporary,
    sessions,
    "1970-01-01T00:00:00.000Z"
  );
  const redactionCases = JSON.parse(
    await readFile(join(fixtureRoot, "redaction/cases.json"), "utf8")
  ) as Array<{ id: string; input: string; expected: string }>;

  const currentEvents = normalizeValue(
    sorted(events.map(encodeLineageEvent), (event) => String(event["id"])),
    temporary,
    transcript
  );
  const currentSessions = normalizeValue(
    sorted(
      sessions.map((session) =>
        sessionProjection(encodeProvenanceSession(session))
      ),
      (session) => String(session["session_id"])
    ),
    temporary,
    transcript
  );
  const oracleEvidence = oracle["session_evidence"] as Record<string, unknown>;
  const currentEvidence = normalizeValue(
    evidenceProjection(evidence as unknown as Record<string, unknown>),
    temporary,
    transcript
  );
  const currentSessionJson = evidenceProjection(
    JSON.parse(sessionEvidenceJson(evidence)) as Record<string, unknown>
  );
  const oracleSessionJson = evidenceProjection(
    JSON.parse(String(oracle["session_json"])) as Record<string, unknown>
  );
  const currentGraph = graphProjection(
    graph as unknown as {
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
    }
  );
  const oracleGraph = graphProjection(
    oracle["graph"] as {
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
    }
  );
  const requiredCodexEvents = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "Stop"
  ];
  const copilot = copilotHooks("lineage-capture")["hooks"] as Record<
    string,
    unknown
  >;
  const hookHashes = oracle["hook_config_hashes"] as Record<string, unknown>;

  const comparisons = {
    events: [
      currentEvents,
      normalizeValue(oracle["events"], temporary, transcript)
    ],
    sessions: [
      currentSessions,
      normalizeValue(
        (oracle["sessions"] as Array<Record<string, unknown>>).map(
          sessionProjection
        ),
        temporary,
        transcript
      )
    ],
    graph: [currentGraph, oracleGraph],
    session_evidence: [
      currentEvidence,
      normalizeValue(
        evidenceProjection(oracleEvidence),
        temporary,
        transcript
      )
    ],
    session_markdown: [
      normalizeText(sessionEvidenceMarkdown(evidence), temporary, transcript),
      normalizeText(String(oracle["session_markdown"]), temporary, transcript)
    ],
    session_json: [
      normalizeValue(currentSessionJson, temporary, transcript),
      normalizeValue(oracleSessionJson, temporary, transcript)
    ],
    agent_trace: [
      normalizeValue(
        traceProjection(traces as unknown as Array<Record<string, unknown>>),
        temporary,
        transcript
      ),
      normalizeValue(
        traceProjection(oracle["agent_trace"] as Array<Record<string, unknown>>),
        temporary,
        transcript
      )
    ],
    redaction: [
      redactionCases.map((item) => ({
        id: item.id,
        expected: item.expected,
        actual: redact(item.input)
      })),
      oracle["redaction"]
    ],
    hook_config_hashes: [
      typeof hookHashes["codex"] === "string" &&
      typeof hookHashes["github_copilot"] === "string" &&
      requiredCodexEvents.every((event) =>
        codexHooks("lineage-capture").includes(`[[hooks.${event}]]`)
      ) &&
      [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PermissionRequest",
        "PostToolUse",
        "PostToolUseFailure",
        "Stop",
        "SessionEnd"
      ].every((event) => Array.isArray(copilot[event])),
      true
    ],
    counts: [
      {
        agent_traces: traces.length,
        events: events.length,
        graph_edges: graph.edges.length,
        graph_nodes: graph.nodes.length,
        sessions: sessions.length,
        transcript_messages: evidence.messages.length
      },
      oracle["counts"]
    ]
  };
  const sections = Object.fromEntries(
    Object.entries(comparisons).map(([section, [current, expected]]) => [
      section,
      equal(current, expected)
    ])
  );
  const differences = Object.fromEntries(
    Object.entries(comparisons)
      .filter(([section]) => !sections[section])
      .map(([section, [current, expected]]) => [
        section,
        firstDifference(current, expected)
      ])
  );
  const failures = Object.entries(sections)
    .filter(([, passed]) => !passed)
    .map(([section]) => section);
  const report = {
    schemaVersion: 1,
    oracleSchemaVersion: oracle["schema_version"],
    baseline: oracle["baseline"],
    sections,
    compatible: failures.length === 0,
    failures,
    differences,
    graphCounts: {
      replacement: {
        nodeKinds: currentGraph.nodeKinds,
        edgeKinds: currentGraph.edgeKinds
      },
      oracle: {
        nodeKinds: oracleGraph.nodeKinds,
        edgeKinds: oracleGraph.edgeKinds
      }
    }
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.compatible ? 0 : 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
