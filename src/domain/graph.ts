import { basename } from "node:path";
import {
  inspectContainedPath,
  readBoundedContainedTextFile,
  safeRelativePath,
  type BoundedTextFile
} from "../shared/path-safety.js";
import {
  MAX_GRAPH_EDGES,
  MAX_GRAPH_EVENTS,
  MAX_GRAPH_NODES,
  MAX_GRAPH_SESSIONS,
  MAX_GRAPH_SOURCE_BYTES,
  MAX_GRAPH_SOURCE_FILES
} from "./limits.js";
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
  truncation?: {
    reasons: string[];
    limits: {
      sessions: number;
      events: number;
      sourceFiles: number;
      sourceBytes: number;
      nodes: number;
      edges: number;
    };
  };
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

export interface GraphSourceSet {
  lines: Map<string, string[]>;
  allowedPaths: Set<string>;
  rejectedPaths: Set<string>;
  truncated: boolean;
}

type GraphSourceReader = (
  repoRoot: string,
  path: string,
  maxBytes: number
) => Promise<BoundedTextFile | undefined>;

async function mapConcurrent<T>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) await operation(values[cursor++]!);
  });
  await Promise.all(workers);
}

export async function loadGraphSources(
  repoRoot: string,
  sessions: ProvenanceSession[],
  readSource: GraphSourceReader = readBoundedContainedTextFile
): Promise<GraphSourceSet> {
  const allPaths = uniqueSorted(
    sessions
      .slice(0, MAX_GRAPH_SESSIONS)
      .flatMap((session) => session.lineRanges.map((range) => range.file))
  );
  const paths = allPaths.slice(0, MAX_GRAPH_SOURCE_FILES);
  const sources: GraphSourceSet = {
    lines: new Map(),
    allowedPaths: new Set(),
    rejectedPaths: new Set(allPaths.slice(MAX_GRAPH_SOURCE_FILES)),
    truncated: allPaths.length > MAX_GRAPH_SOURCE_FILES
  };

  await mapConcurrent(paths, 16, async (path) => {
    if (!safeRelativePath(path)) {
      sources.rejectedPaths.add(path);
      return;
    }
    const inspected = await inspectContainedPath(repoRoot, path);
    if (inspected.status === "unsafe" || inspected.status === "directory" || inspected.status === "other") {
      sources.rejectedPaths.add(path);
      return;
    }
    sources.allowedPaths.add(path);
    if (inspected.status === "missing") return;
    const source = await readSource(repoRoot, path, MAX_GRAPH_SOURCE_BYTES);
    if (!source) {
      sources.allowedPaths.delete(path);
      sources.rejectedPaths.add(path);
      return;
    }
    if (source.truncated) {
      sources.truncated = true;
      return;
    }
    sources.lines.set(path, source.text.split(/\r?\n/));
  });
  return sources;
}

function fileContentHash(
  sources: GraphSourceSet,
  file: string,
  start: number,
  end: number
): string | undefined {
  const lines = sources.lines.get(file);
  if (!lines || start <= 0 || start > lines.length) return undefined;
  return sha256(lines.slice(start - 1, Math.min(Math.max(end, start), lines.length)).join("\n"));
}

export async function buildProvenanceGraph(
  repoRoot: string,
  sessions: ProvenanceSession[],
  events: LineageEvent[] = [],
  loadedSources?: GraphSourceSet,
  inputTruncationReasons: string[] = []
): Promise<ProvenanceGraph> {
  const graphSessions = sessions.slice(0, MAX_GRAPH_SESSIONS);
  const graphEvents = events.slice(-MAX_GRAPH_EVENTS);
  const sources = loadedSources ?? await loadGraphSources(repoRoot, graphSessions);
  const truncationReasons = new Set<string>(inputTruncationReasons);
  if (sessions.length > graphSessions.length) truncationReasons.add("sessions");
  if (events.length > graphEvents.length) truncationReasons.add("events");
  if (sources.truncated) truncationReasons.add("sources");
  if (sources.rejectedPaths.size > 0) truncationReasons.add("unsafe_paths");
  const nodes = new Map<string, ProvenanceNode>();
  const edges = new Map<string, ProvenanceEdge>();
  const addNode = (node: ProvenanceNode): boolean => {
    if (!nodes.has(node.id) && nodes.size >= MAX_GRAPH_NODES) {
      truncationReasons.add("nodes");
      return false;
    }
    nodes.set(node.id, node);
    return true;
  };
  const addEdge = (
    from: string,
    to: string,
    kind: ProvenanceEdge["kind"],
    confidence?: number
  ) => {
    if (!nodes.has(from) || !nodes.has(to)) return;
    const id = provenanceId.edge(from, to, kind);
    if (!edges.has(id) && edges.size >= MAX_GRAPH_EDGES) {
      truncationReasons.add("edges");
      return;
    }
    const edge: ProvenanceEdge = {
      id,
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
  for (const event of graphEvents) {
    const key = `${event.provider}\0${event.sessionId}`;
    const sessionEvents = eventsBySession.get(key);
    if (sessionEvents) sessionEvents.push(event);
    else eventsBySession.set(key, [event]);
  }

  for (const session of graphSessions) {
    const sessionNodeId = provenanceId.session(session.sessionId);
    const sessionNode: ProvenanceNode = {
      id: sessionNodeId,
      kind: "session",
      label: `${session.providerDisplayName} ${session.sessionId.slice(0, 12)}`,
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
      ...session.lineRanges
        .filter((range) => sources.allowedPaths.has(range.file))
        .map((range) => range.file)
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
      if (!sources.allowedPaths.has(range.file)) continue;
      const fileId = provenanceId.file(repoRoot, session.commitSha, range.file);
      const rangeId = provenanceId.range(
        repoRoot,
        session.commitSha,
        range.file,
        range.start,
        range.end
      );
      const rangeHash = fileContentHash(sources, range.file, range.start, range.end);
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
        const contentHash = fileContentHash(sources, range.file, line, line);
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
      ...session.externalConstraints.map((record) => [
        "constraint",
        record.startLine
          ? `${record.filePath}:${record.startLine}${record.endLine ? `-${record.endLine}` : ""}`
          : record.filePath,
        record.id
      ] as const)
    ];
    for (const event of eventsBySession.get(`${session.provider}\0${session.sessionId}`) ?? []) {
      if (event.eventType === "prompt") {
        evidence.push(["prompt", event.providerEventName, event.id]);
        continue;
      }
      if (event.eventType === "pre_tool_use" || event.eventType === "post_tool_use") {
        const tool = event.payload["tool_name"];
        if (typeof tool === "string" && tool) {
          evidence.push(["tool", tool, event.id]);
        }
      }
    }
    for (const [kind, label, value] of evidence) {
      if (!value) continue;
      const id = provenanceId.evidence(kind, session.sessionId, value);
      addNode({
        id,
        kind,
        label,
        sessionId: session.sessionId,
        ...(session.turnId ? { turnId: session.turnId } : {}),
        provider: session.provider,
        metadata: { text: value }
      });
      addEdge(evidenceParent, id, "contains");
      for (const range of session.lineRanges) {
        if (
          range.start <= 0 ||
          range.end < range.start ||
          !sources.allowedPaths.has(range.file)
        ) {
          continue;
        }
        addEdge(
          id,
          provenanceId.range(
            repoRoot,
            session.commitSha,
            range.file,
            range.start,
            range.end
          ),
          "evidenced_by",
          range.confidence
        );
      }
    }
  }

  const graph: ProvenanceGraph = {
    nodes: [...nodes.values()].sort((left, right) =>
      `${left.kind}|${left.label}|${left.id}`.localeCompare(`${right.kind}|${right.label}|${right.id}`)
    ),
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id))
  };
  if (truncationReasons.size > 0) {
    graph.truncation = {
      reasons: [...truncationReasons].sort(),
      limits: {
        sessions: MAX_GRAPH_SESSIONS,
        events: MAX_GRAPH_EVENTS,
        sourceFiles: MAX_GRAPH_SOURCE_FILES,
        sourceBytes: MAX_GRAPH_SOURCE_BYTES,
        nodes: MAX_GRAPH_NODES,
        edges: MAX_GRAPH_EDGES
      }
    };
  }
  return graph;
}
