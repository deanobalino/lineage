import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { JsonValue, LineageEvent, ProvenanceSession } from "./models.js";
import { sha256, stableId, uniqueSorted } from "./stable.js";

export type ProvenanceNodeKind =
  | "repository"
  | "commit"
  | "file"
  | "range"
  | "line"
  | "session"
  | "turn"
  | "prompt"
  | "final_message"
  | "tool"
  | "test"
  | "decision"
  | "constraint"
  | "event";

export interface ProvenanceNode {
  id: string;
  kind: ProvenanceNodeKind;
  label: string;
  repoRoot?: string;
  commitSha?: string;
  sessionId?: string;
  turnId?: string;
  provider?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  contentHash?: string;
  metadata: Record<string, JsonValue>;
}

export interface ProvenanceEdge {
  id: string;
  from: string;
  to: string;
  kind: "contains" | "touches" | "evidenced_by" | "derived_from";
  confidence?: number;
  metadata: Record<string, JsonValue>;
}

export interface ProvenanceGraph {
  nodes: ProvenanceNode[];
  edges: ProvenanceEdge[];
}

export const provenanceId = {
  repository: (repoRoot: string) => stableId("repo", repoRoot),
  commit: (repoRoot: string, sha: string) => stableId("commit", repoRoot, sha),
  file: (repoRoot: string, commitSha: string | undefined, path: string) =>
    stableId("file", repoRoot, commitSha ?? "working", path),
  range: (
    repoRoot: string,
    commitSha: string | undefined,
    path: string,
    start: number,
    end: number
  ) => stableId("range", repoRoot, commitSha ?? "working", path, `${start}-${end}`),
  line: (
    repoRoot: string,
    commitSha: string | undefined,
    path: string,
    line: number,
    contentHash: string | undefined
  ) => stableId("line", repoRoot, commitSha ?? "working", path, line, contentHash),
  session: (sessionId: string) => stableId("session", sessionId),
  turn: (sessionId: string, turnId: string) => stableId("turn", sessionId, turnId),
  evidence: (kind: ProvenanceNodeKind, sessionId: string, key: string) =>
    stableId(kind, sessionId, key),
  edge: (from: string, to: string, kind: string) => stableId("edge", from, kind, to)
};

function fileContentHash(
  repoRoot: string,
  file: string,
  start: number,
  end: number
): string | undefined {
  try {
    const lines = readFileSync(join(repoRoot, file), "utf8").split(/\r?\n/);
    if (start <= 0 || start > lines.length) return undefined;
    return sha256(lines.slice(start - 1, Math.min(Math.max(end, start), lines.length)).join("\n"));
  } catch {
    return undefined;
  }
}

export function buildProvenanceGraph(
  repoRoot: string,
  sessions: ProvenanceSession[],
  events: LineageEvent[] = []
): ProvenanceGraph {
  const nodes = new Map<string, ProvenanceNode>();
  const edges = new Map<string, ProvenanceEdge>();
  const addNode = (node: ProvenanceNode) => nodes.set(node.id, node);
  const addEdge = (
    from: string,
    to: string,
    kind: ProvenanceEdge["kind"],
    confidence?: number
  ) => {
    const edge: ProvenanceEdge = {
      id: provenanceId.edge(from, to, kind),
      from,
      to,
      kind,
      metadata: {}
    };
    if (confidence !== undefined) edge.confidence = confidence;
    edges.set(edge.id, edge);
  };

  const repositoryId = provenanceId.repository(repoRoot);
  addNode({
    id: repositoryId,
    kind: "repository",
    label: basename(repoRoot),
    repoRoot,
    metadata: {}
  });

  const eventsBySession = new Map<string, LineageEvent[]>();
  for (const event of events) {
    eventsBySession.set(event.sessionId, [...(eventsBySession.get(event.sessionId) ?? []), event]);
  }

  for (const session of sessions) {
    const sessionNodeId = provenanceId.session(session.sessionId);
    const sessionNode: ProvenanceNode = {
      id: sessionNodeId,
      kind: "session",
      label: `${session.providerDisplayName} ${session.sessionId.slice(0, 8)}`,
      repoRoot,
      sessionId: session.sessionId,
      provider: session.provider,
      metadata: {
        source: session.source,
        actor: session.actor,
        model: session.model ?? null,
        "lineage.session_path": `${session.provider}-${session.sessionId}.json`
      }
    };
    if (session.commitSha) sessionNode.commitSha = session.commitSha;
    if (session.turnId) sessionNode.turnId = session.turnId;
    addNode(sessionNode);
    addEdge(repositoryId, sessionNodeId, "contains");

    let evidenceParent = sessionNodeId;
    if (session.turnId) {
      const turnId = provenanceId.turn(session.sessionId, session.turnId);
      addNode({
        id: turnId,
        kind: "turn",
        label: `Turn ${session.turnId.slice(0, 8)}`,
        sessionId: session.sessionId,
        turnId: session.turnId,
        provider: session.provider,
        metadata: {}
      });
      addEdge(sessionNodeId, turnId, "contains");
      evidenceParent = turnId;
    }

    let commitId: string | undefined;
    if (session.commitSha) {
      commitId = provenanceId.commit(repoRoot, session.commitSha);
      addNode({
        id: commitId,
        kind: "commit",
        label: session.commitSha.slice(0, 8),
        repoRoot,
        commitSha: session.commitSha,
        metadata: { message: session.commitMessage ?? null }
      });
      addEdge(repositoryId, commitId, "contains");
      addEdge(sessionNodeId, commitId, "touches");
    }

    const files = uniqueSorted([
      ...session.filesEdited,
      ...session.lineRanges.map((range) => range.file)
    ]);
    for (const file of files) {
      const fileId = provenanceId.file(repoRoot, session.commitSha, file);
      addNode({
        id: fileId,
        kind: "file",
        label: file,
        repoRoot,
        ...(session.commitSha ? { commitSha: session.commitSha } : {}),
        filePath: file,
        metadata: {}
      });
      addEdge(commitId ?? repositoryId, fileId, "contains");
      addEdge(sessionNodeId, fileId, "touches");
    }

    for (const range of session.lineRanges) {
      if (range.start <= 0 || range.end < range.start) continue;
      const fileId = provenanceId.file(repoRoot, session.commitSha, range.file);
      const rangeId = provenanceId.range(
        repoRoot,
        session.commitSha,
        range.file,
        range.start,
        range.end
      );
      const rangeHash = fileContentHash(repoRoot, range.file, range.start, range.end);
      const rangeNode: ProvenanceNode = {
        id: rangeId,
        kind: "range",
        label: `${range.file}:${range.start}-${range.end}`,
        repoRoot,
        filePath: range.file,
        startLine: range.start,
        endLine: range.end,
        metadata: { label: range.label }
      };
      if (session.commitSha) rangeNode.commitSha = session.commitSha;
      if (rangeHash) rangeNode.contentHash = rangeHash;
      addNode(rangeNode);
      addEdge(fileId, rangeId, "contains");
      addEdge(sessionNodeId, rangeId, "touches", range.confidence);
      addEdge(sessionNodeId, rangeId, "evidenced_by", range.confidence);

      const limit = Math.min(range.end, range.start + 199);
      for (let line = range.start; line <= limit; line += 1) {
        const contentHash = fileContentHash(repoRoot, range.file, line, line);
        const lineId = provenanceId.line(
          repoRoot,
          session.commitSha,
          range.file,
          line,
          contentHash
        );
        const lineNode: ProvenanceNode = {
          id: lineId,
          kind: "line",
          label: `${range.file}:${line}`,
          repoRoot,
          filePath: range.file,
          startLine: line,
          endLine: line,
          metadata: {}
        };
        if (session.commitSha) lineNode.commitSha = session.commitSha;
        if (contentHash) lineNode.contentHash = contentHash;
        addNode(lineNode);
        addEdge(rangeId, lineId, "contains");
        addEdge(sessionNodeId, lineId, "touches", range.confidence);
        addEdge(sessionNodeId, lineId, "evidenced_by", range.confidence);
      }
    }

    const evidence: Array<readonly [ProvenanceNodeKind, string, string]> = [
      ["prompt", "Prompt", session.prompt],
      ["final_message", "Final message", session.lastAssistantMessage],
      ...session.toolsUsed.map((tool, index) => ["tool", tool, `tool-${index}:${tool}`] as const),
      ...session.commandsRun.map((command, index) => ["tool", command, `command-${index}:${command}`] as const),
      ...session.testsRun.map((test, index) => ["test", test, `test-${index}:${test}`] as const),
      ...session.decisions.map((record) => ["decision", record.kind, record.id] as const),
      ...session.externalConstraints.map((record) => ["constraint", record.summary, record.id] as const)
    ];
    for (const [kind, label, value] of evidence) {
      if (!value) continue;
      const id = provenanceId.evidence(kind, session.sessionId, value);
      addNode({
        id,
        kind,
        label,
        sessionId: session.sessionId,
        provider: session.provider,
        metadata: { text: value }
      });
      addEdge(evidenceParent, id, "contains");
      addEdge(id, sessionNodeId, "derived_from");
    }

    for (const event of eventsBySession.get(session.sessionId) ?? []) {
      const id = provenanceId.evidence("event", session.sessionId, event.id);
      addNode({
        id,
        kind: "event",
        label: event.providerEventName,
        sessionId: session.sessionId,
        provider: session.provider,
        metadata: { event_id: event.id, event_type: event.eventType }
      });
      addEdge(evidenceParent, id, "contains");
    }
  }

  return {
    nodes: [...nodes.values()].sort((left, right) =>
      `${left.kind}|${left.label}|${left.id}`.localeCompare(`${right.kind}|${right.label}|${right.id}`)
    ),
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id))
  };
}
