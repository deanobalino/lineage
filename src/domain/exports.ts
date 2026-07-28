import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LineExplanation, ProvenanceSession } from "./models.js";
import type { SessionEvidence } from "./evidence.js";
import { redact } from "./evidence.js";
import { buildProvenanceGraph } from "./graph.js";
import { sha256 } from "./stable.js";

export function sessionEvidenceMarkdown(bundle: SessionEvidence): string {
  const commit = [bundle.commitSha, bundle.commitMessage].filter(Boolean).join(" - ");
  return `# Lineage Session Evidence

Provider: ${bundle.provider}
Source: ${bundle.source}
Session: ${bundle.sessionId}
Model: ${bundle.model ?? "Unknown"}
Permission mode: ${bundle.permissionMode ?? "Unknown"}
Commit: ${commit}
Transcript path: ${bundle.transcriptPath ?? "Unavailable"}
Transcript available: ${bundle.transcriptAvailable ? "yes" : "no"}

Note: This export contains captured provider transcript/events and Git evidence only. It does not include or claim private model reasoning.

## Prompt

${bundle.prompt}

## Final Message

${bundle.finalMessage}

## Tools

${bundle.toolsUsed.map((tool) => `- ${tool}`).join("\n")}

## Commands

${bundle.commandsRun.map((command) => `- \`${command}\``).join("\n")}

## Permissions

${bundle.permissionRequests.map((request) => `- ${request}`).join("\n")}

## Tests

Result: ${bundle.testsResult}

${bundle.testsRun.map((test) => `- \`${test}\``).join("\n")}

## Files Edited

${bundle.filesEdited.map((file) => `- ${file}`).join("\n")}

## Line Ranges

${bundle.lineRanges
  .map(
    (range) =>
      `- ${range.file}:${range.start}-${range.end} (${Math.trunc(range.confidence * 100)}%, ${range.label})`
  )
  .join("\n")}

## Event Timeline

${bundle.timeline
  .map((event) => `- [${event.group}] ${event.title}: ${event.detail}`)
  .join("\n")}

## Transcript

${bundle.messages
  .map((message) => `### ${message.title}\n\n${message.body}`)
  .join("\n\n")}

## Git Diff

\`\`\`diff
${bundle.gitDiff}
\`\`\``;
}

export function sessionEvidenceJson(bundle: SessionEvidence): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export function explanationMarkdown(explanation: LineExplanation): string {
  return `# Lineage Explanation

${explanation.file}:${explanation.line}

## Answer

${redact(explanation.answer)}

## Decision provenance

${explanation.decisionProvenance.label}

${redact(explanation.decisionProvenance.detail)}

## Evidence

${explanation.evidenceCards
  .map((card) => `### ${card.title}\n\n${redact(card.body)}`)
  .join("\n\n")}

## Removal assessment

${redact(explanation.removalAssessment)}
`;
}

export interface AgentTraceRecord {
  version: "0.1.0";
  id: string;
  timestamp: string;
  vcs?: { type: "git"; revision: string };
  tool: { name: string; version: null };
  files: Array<{
    path: string;
    conversations: Array<{
      url: string;
      contributor: { type: "ai"; model_id?: string };
      ranges: Array<{ start_line: number; end_line: number; content_hash?: string }>;
      related: Array<{ type: string; url: string }>;
    }>;
  }>;
  metadata: Record<string, unknown>;
}

function traceId(session: ProvenanceSession): string {
  const hash = sha256(`${session.provider}|${session.sessionId}|${session.commitSha ?? ""}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function rangeHash(
  repoRoot: string,
  file: string,
  start: number,
  end: number
): Promise<string | undefined> {
  try {
    const lines = (await readFile(join(repoRoot, file), "utf8")).split(/\r?\n/);
    if (start <= 0 || start > lines.length) return undefined;
    return sha256(lines.slice(start - 1, Math.min(Math.max(end, start), lines.length)).join("\n"));
  } catch {
    return undefined;
  }
}

export async function agentTraceRecords(
  repoRoot: string,
  sessions: ProvenanceSession[],
  timestamp = new Date().toISOString()
): Promise<AgentTraceRecord[]> {
  const graph = buildProvenanceGraph(repoRoot, sessions);
  const records: AgentTraceRecord[] = [];
  for (const session of sessions) {
    const files: AgentTraceRecord["files"] = [];
    const paths = [...new Set(session.lineRanges.map((range) => range.file))].sort();
    for (const path of paths) {
      const ranges = await Promise.all(
        session.lineRanges
          .filter((range) => range.file === path && range.start > 0 && range.end >= range.start)
          .sort((left, right) => left.start - right.start || left.end - right.end)
          .map(async (range) => {
            const value: { start_line: number; end_line: number; content_hash?: string } = {
              start_line: range.start,
              end_line: range.end
            };
            const contentHash = await rangeHash(repoRoot, path, range.start, range.end);
            if (contentHash) value.content_hash = contentHash;
            return value;
          })
      );
      if (ranges.length === 0) continue;
      const url = session.transcriptPath
        ? new URL(`file://${session.transcriptPath}`).href
        : `lineage://session/${session.provider}/${session.sessionId}`;
      const contributor: { type: "ai"; model_id?: string } = { type: "ai" };
      if (session.model) contributor.model_id = session.model;
      const related = [{ type: "session", url: `lineage://session/${session.provider}/${session.sessionId}` }];
      if (session.transcriptPath) related.push({ type: "transcript", url });
      files.push({
        path,
        conversations: [{ url, contributor, ranges, related }]
      });
    }
    if (files.length === 0) continue;
    const record: AgentTraceRecord = {
      version: "0.1.0",
      id: traceId(session),
      timestamp,
      tool: { name: session.provider, version: null },
      files,
      metadata: {
        "dev.lineage": {
          session_id: session.sessionId,
          provider: session.provider,
          provider_display_name: session.providerDisplayName,
          source: session.source,
          turn_id: session.turnId ?? null,
          tests_result: session.testsResult,
          tools_used: session.toolsUsed,
          files_edited: session.filesEdited,
          graph_nodes: graph.nodes.length,
          has_raw_telemetry_payload: session.rawTelemetryPayload !== undefined,
          raw_payload_policy:
            "Provider-specific raw payloads remain in .lineage/provenance/events.jsonl and session JSON."
        }
      }
    };
    if (session.commitSha) record.vcs = { type: "git", revision: session.commitSha };
    records.push(record);
  }
  return records;
}

export function agentTraceJsonl(records: AgentTraceRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
}
