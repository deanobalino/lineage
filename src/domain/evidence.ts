import { readBoundedTextFile } from "../shared/path-safety.js";
import {
  MAX_TRANSCRIPT_BYTES,
  MAX_TRANSCRIPT_LINES,
  MAX_TRANSCRIPT_MESSAGES
} from "./limits.js";
import type { LineRange, ProvenanceSession } from "./models.js";
import { stableId } from "./stable.js";

export interface TranscriptMessage {
  id: string;
  timestamp?: string;
  role: string;
  title: string;
  body: string;
}

export interface TimelineEvent {
  id: string;
  group: string;
  title: string;
  detail: string;
}

export interface SessionEvidence {
  sessionId: string;
  provider: string;
  source: string;
  model?: string;
  permissionMode?: string;
  transcriptPath?: string;
  transcriptAvailable: boolean;
  transcriptTruncated?: true;
  transcriptLimits?: {
    bytes: number;
    lines: number;
    messages: number;
  };
  prompt: string;
  finalMessage: string;
  toolsUsed: string[];
  commandsRun: string[];
  permissionRequests: string[];
  filesEdited: string[];
  lineRanges: LineRange[];
  timeline: TimelineEvent[];
  testsRun: string[];
  testsResult: string;
  gitDiff: string;
  commitSha?: string;
  commitMessage?: string;
  messages: TranscriptMessage[];
}

const secretPatterns = [
  /sk-proj-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /bearer\s+[A-Za-z0-9._-]{12,}/gi,
  /(authorization:\s*)(Bearer\s+)?[A-Za-z0-9._-]{12,}/gi,
  /\b(api[_-]?key|token|secret|password|passwd|auth[_-]?token)\s*=\s*['"]?[^'"\s]+/gi
];

export function redact(value: string): string {
  return secretPatterns.reduce(
    (output, pattern) => output.replace(pattern, "[REDACTED]"),
    value
  );
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseTranscriptLine(line: string, fallbackId: string): TranscriptMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  const root = object(parsed);
  const payload = Object.keys(object(root["payload"])).length > 0 ? object(root["payload"]) : root;
  const timestamp = typeof root["timestamp"] === "string" ? root["timestamp"] : undefined;
  const type = typeof payload["type"] === "string" ? payload["type"] : undefined;
  const id =
    (typeof payload["id"] === "string" && payload["id"]) ||
    (typeof payload["call_id"] === "string" && payload["call_id"]) ||
    fallbackId;
  const build = (role: string, title: string, body: unknown): TranscriptMessage | undefined => {
    if (typeof body !== "string") return undefined;
    const result: TranscriptMessage = { id, role, title, body: redact(body) };
    if (timestamp) result.timestamp = timestamp;
    return result;
  };
  if (type === "user_message") return build("user", "User", payload["message"]);
  if (type === "agent_message") return build("assistant", "Assistant", payload["message"]);
  if (type === "function_call" || type === "custom_tool_call") {
    return build(
      "tool",
      typeof payload["name"] === "string" ? payload["name"] : "Tool",
      payload["arguments"] ?? payload["input"] ?? ""
    );
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    return build("tool", "Tool result", payload["output"] ?? payload["stdout"] ?? "");
  }
  if (type && /(permission|approval)/i.test(type)) {
    return build("permission", type, JSON.stringify(payload));
  }
  const role = typeof payload["role"] === "string" ? payload["role"].toLowerCase() : type;
  const body = payload["message"] ?? payload["content"] ?? payload["text"];
  if (role && ["user", "assistant", "agent", "system"].includes(role)) {
    const normalized = role === "agent" ? "assistant" : role;
    return build(
      normalized,
      normalized === "user" ? "User" : normalized === "assistant" ? "Assistant" : "System",
      body
    );
  }
  const toolName = payload["toolName"] ?? payload["tool_name"];
  if (typeof toolName === "string") {
    const input =
      payload["toolArgs"] ??
      payload["tool_input"] ??
      payload["input"] ??
      payload["toolResult"] ??
      payload["tool_result"] ??
      "";
    return build("tool", toolName, typeof input === "string" ? input : JSON.stringify(input));
  }
  return undefined;
}

export function buildTimeline(session: ProvenanceSession): TimelineEvent[] {
  const entries: Array<[string, string, string]> = [];
  if (session.prompt) entries.push(["Prompt", "User prompt", session.prompt]);
  for (const tool of session.toolsUsed) entries.push(["Tool", tool, `Tool used by ${session.providerDisplayName}.`]);
  for (const command of session.commandsRun) entries.push(["Tool", "Command", command]);
  for (const decision of session.decisions) {
    entries.push([
      "Decision",
      decision.kind,
      [
        decision.context,
        decision.selectedOptionText ? `Selected: ${decision.selectedOptionText}` : "",
        decision.freeformResponse ? `Freeform: ${decision.freeformResponse}` : "",
        decision.permissionStatus ? `Permission: ${decision.permissionStatus}` : "",
        decision.consequences ? `Consequences: ${decision.consequences}` : ""
      ].filter(Boolean).join("\n")
    ]);
  }
  for (const constraint of session.externalConstraints) {
    const location = constraint.startLine
      ? `${constraint.filePath}:${constraint.startLine}${constraint.endLine ? `-${constraint.endLine}` : ""}`
      : constraint.filePath;
    entries.push(["Constraint", location, constraint.summary]);
  }
  for (const test of session.testsRun) entries.push(["Test", test, `Result: ${session.testsResult}`]);
  if (session.lastAssistantMessage) entries.push(["Final response", "Final provider message", session.lastAssistantMessage]);
  return entries.map(([group, title, detail], index) => ({
    id: stableId("timeline", session.sessionId, index, group, title, detail),
    group,
    title,
    detail: redact(detail)
  }));
}

export async function loadSessionEvidence(session: ProvenanceSession): Promise<SessionEvidence> {
  let messages: TranscriptMessage[] = [];
  let transcriptAvailable = false;
  let transcriptTruncated = false;
  if (session.transcriptPath) {
    try {
      const transcript = await readBoundedTextFile(session.transcriptPath, MAX_TRANSCRIPT_BYTES);
      if (transcript) {
        transcriptAvailable = true;
        let text = transcript.text;
        if (transcript.truncated) {
          const lastCompleteLine = text.lastIndexOf("\n");
          text = lastCompleteLine >= 0 ? text.slice(0, lastCompleteLine) : "";
        }
        let cursor = 0;
        let lineNumber = 0;
        while (
          cursor <= text.length &&
          lineNumber < MAX_TRANSCRIPT_LINES &&
          messages.length < MAX_TRANSCRIPT_MESSAGES
        ) {
          const newline = text.indexOf("\n", cursor);
          const end = newline < 0 ? text.length : newline;
          const line = text.slice(cursor, end);
          if (line.trim()) {
            const message = parseTranscriptLine(line, String(lineNumber));
            if (message) messages.push(message);
          }
          lineNumber += 1;
          if (newline < 0) {
            cursor = text.length + 1;
            break;
          }
          cursor = newline + 1;
        }
        transcriptTruncated =
          transcript.truncated ||
          cursor <= text.length ||
          lineNumber >= MAX_TRANSCRIPT_LINES ||
          messages.length >= MAX_TRANSCRIPT_MESSAGES;
      }
    } catch {
      transcriptAvailable = false;
    }
  }
  const evidence: SessionEvidence = {
    sessionId: session.sessionId,
    provider: session.providerDisplayName,
    source: session.source,
    transcriptAvailable,
    prompt: redact(session.prompt),
    finalMessage: redact(session.lastAssistantMessage),
    toolsUsed: session.toolsUsed.map(redact),
    commandsRun: session.commandsRun.map(redact),
    permissionRequests: session.permissionRequests.map(redact),
    filesEdited: session.filesEdited,
    lineRanges: session.lineRanges,
    timeline: buildTimeline(session),
    testsRun: session.testsRun.map(redact),
    testsResult: redact(session.testsResult),
    gitDiff: redact(session.gitDiff),
    messages
  };
  if (transcriptTruncated) {
    evidence.transcriptTruncated = true;
    evidence.transcriptLimits = {
      bytes: MAX_TRANSCRIPT_BYTES,
      lines: MAX_TRANSCRIPT_LINES,
      messages: MAX_TRANSCRIPT_MESSAGES
    };
  }
  const optional: Array<[keyof SessionEvidence, string | undefined]> = [
    ["model", session.model],
    ["permissionMode", session.permissionMode],
    ["transcriptPath", session.transcriptPath],
    ["commitSha", session.commitSha],
    ["commitMessage", session.commitMessage]
  ];
  for (const [key, value] of optional) if (value) Object.assign(evidence, { [key]: value });
  return evidence;
}
