import type {
  DecisionOption,
  DecisionRecord,
  ExternalConstraint,
  JsonValue,
  LineageEvent,
  LineRange,
  ProvenanceSession
} from "./models.js";
import { isJsonValue, providerDisplayName, providers } from "./models.js";
import { stableId } from "./stable.js";

type UnknownObject = Record<string, unknown>;

function object(value: unknown): UnknownObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownObject)
    : {};
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function jsonObject(value: unknown): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(object(value))) {
    if (isJsonValue(item)) result[key] = item;
  }
  return result;
}

function decisionOption(value: unknown): DecisionOption | undefined {
  const item = object(value);
  const text = optionalString(item["text"]);
  if (!text) return undefined;
  const option: DecisionOption = { id: string(item["id"], stableId("option", text)), text };
  const rationale = optionalString(item["rationale"]);
  if (rationale) option.rationale = rationale;
  return option;
}

function decision(value: unknown): DecisionRecord | undefined {
  const item = object(value);
  const record: DecisionRecord = {
    id: string(item["id"], stableId("decision", JSON.stringify(item))),
    kind: string(item["kind"], "decision"),
    context: string(item["context"]),
    alternatives: Array.isArray(item["alternatives"])
      ? item["alternatives"].map(decisionOption).filter((entry): entry is DecisionOption => Boolean(entry))
      : [],
    evidence: strings(item["evidence"])
  };
  const selectedOptionText = optionalString(item["selected_option_text"]);
  const freeformResponse = optionalString(item["freeform_response"]);
  const permissionStatus = optionalString(item["permission_status"]);
  const consequences = optionalString(item["consequences"]);
  if (selectedOptionText) record.selectedOptionText = selectedOptionText;
  if (freeformResponse) record.freeformResponse = freeformResponse;
  if (permissionStatus) record.permissionStatus = permissionStatus;
  if (consequences) record.consequences = consequences;
  return record;
}

function constraint(value: unknown): ExternalConstraint | undefined {
  const item = object(value);
  const summary = optionalString(item["summary"]);
  if (!summary) return undefined;
  const result: ExternalConstraint = {
    id: string(item["id"], stableId("constraint", JSON.stringify(item))),
    filePath: string(item["file_path"]),
    summary,
    source: string(item["source"], "provider_payload")
  };
  const startLine = number(item["start_line"]);
  const endLine = number(item["end_line"]);
  const excerpt = optionalString(item["excerpt"]);
  if (startLine !== undefined) result.startLine = startLine;
  if (endLine !== undefined) result.endLine = endLine;
  if (excerpt) result.excerpt = excerpt;
  return result;
}

function lineRange(value: unknown): LineRange | undefined {
  const item = object(value);
  const file = optionalString(item["file"]);
  const start = number(item["start"]);
  const end = number(item["end"]);
  if (!file || start === undefined || end === undefined) return undefined;
  return {
    file,
    start,
    end,
    confidence: number(item["confidence"]) ?? 0,
    label: string(item["label"], "Recorded")
  };
}

export function decodeLineageEvent(value: unknown): LineageEvent | undefined {
  const item = object(value);
  const id = optionalString(item["id"]);
  const capturedAt = optionalString(item["captured_at"]);
  const provider = optionalString(item["provider"]);
  const sessionId = optionalString(item["session_id"]);
  if (!id || !capturedAt || !provider || !sessionId || Number.isNaN(Date.parse(capturedAt))) return undefined;

  const event: LineageEvent = {
    id,
    lineageSchemaVersion: string(item["lineage_schema_version"], "0.1"),
    capturedAt: new Date(capturedAt).toISOString(),
    source: string(item["source"], `${provider}-hook`),
    provider,
    providerEventName: string(item["provider_event_name"]),
    eventType: string(item["event_type"]),
    actor: string(item["actor"], providerDisplayName(provider)),
    hookEventName: string(item["hook_event_name"], string(item["provider_event_name"])),
    sessionId,
    payload: jsonObject(item["payload"])
  };
  const optional: Array<[keyof LineageEvent, unknown]> = [
    ["human", item["human"]],
    ["turnId", item["turn_id"]],
    ["cwd", item["cwd"]],
    ["repoRoot", item["repo_root"]],
    ["model", item["model"]],
    ["permissionMode", item["permission_mode"]],
    ["transcriptPath", item["transcript_path"]]
  ];
  for (const [key, candidate] of optional) {
    const value = optionalString(candidate);
    if (value) Object.assign(event, { [key]: value });
  }
  const sequence = number(item["provider_sequence"]);
  if (sequence !== undefined) event.providerSequence = sequence;
  return event;
}

export function decodeProvenanceSession(value: unknown): ProvenanceSession | undefined {
  const item = object(value);
  const sessionId = optionalString(item["session_id"]);
  if (!sessionId) return undefined;
  const provider = string(item["provider"], providers.codex.id);
  const session: ProvenanceSession = {
    provider,
    providerDisplayName: string(item["provider_display_name"], providerDisplayName(provider)),
    sessionId,
    source: string(item["source"], provider),
    actor: string(item["actor"], providerDisplayName(provider)),
    humanReviewer: string(item["human_reviewer"], "Unknown"),
    prompt: string(item["prompt"]),
    toolsUsed: strings(item["tools_used"]),
    commandsRun: strings(item["commands_run"]),
    filesEdited: strings(item["files_edited"]),
    testsRun: strings(item["tests_run"]),
    testsResult: string(item["tests_result"], "unknown"),
    permissionRequests: strings(item["permission_requests"]),
    decisions: Array.isArray(item["decisions"])
      ? item["decisions"].map(decision).filter((entry): entry is DecisionRecord => Boolean(entry))
      : [],
    externalConstraints: Array.isArray(item["external_constraints"])
      ? item["external_constraints"].map(constraint).filter((entry): entry is ExternalConstraint => Boolean(entry))
      : [],
    lastAssistantMessage: string(item["last_assistant_message"]),
    gitDiff: string(item["git_diff"]),
    reasoningSummary: string(item["reasoning_summary"]),
    lineRanges: Array.isArray(item["line_ranges"])
      ? item["line_ranges"].map(lineRange).filter((entry): entry is LineRange => Boolean(entry))
      : []
  };
  const optional: Array<[keyof ProvenanceSession, unknown]> = [
    ["turnId", item["turn_id"]],
    ["human", item["human"]],
    ["model", item["model"]],
    ["permissionMode", item["permission_mode"]],
    ["transcriptPath", item["transcript_path"]],
    ["commitSha", item["commit_sha"]],
    ["commitMessage", item["commit_message"]]
  ];
  for (const [key, candidate] of optional) {
    const value = optionalString(candidate);
    if (value) Object.assign(session, { [key]: value });
  }
  if (isJsonValue(item["raw_telemetry_payload"])) session.rawTelemetryPayload = item["raw_telemetry_payload"];
  const known = new Set([
    "provider", "provider_display_name", "session_id", "turn_id", "source", "actor",
    "human", "model", "permission_mode", "transcript_path", "human_reviewer", "prompt",
    "tools_used", "commands_run", "files_edited", "tests_run", "tests_result",
    "permission_requests", "decisions", "external_constraints", "last_assistant_message",
    "git_diff", "commit_sha", "commit_message", "reasoning_summary", "line_ranges",
    "raw_telemetry_payload"
  ]);
  const extra: Record<string, JsonValue> = {};
  for (const [key, candidate] of Object.entries(item)) {
    if (!known.has(key) && isJsonValue(candidate)) extra[key] = candidate;
  }
  if (Object.keys(extra).length > 0) session.extra = extra;
  return session;
}

export function encodeLineageEvent(event: LineageEvent): Record<string, JsonValue> {
  return {
    id: event.id,
    lineage_schema_version: event.lineageSchemaVersion,
    captured_at: event.capturedAt,
    ...(event.providerSequence === undefined ? {} : { provider_sequence: event.providerSequence }),
    source: event.source,
    provider: event.provider,
    provider_event_name: event.providerEventName,
    event_type: event.eventType,
    actor: event.actor,
    ...(event.human ? { human: event.human } : {}),
    hook_event_name: event.hookEventName,
    session_id: event.sessionId,
    ...(event.turnId ? { turn_id: event.turnId } : {}),
    ...(event.cwd ? { cwd: event.cwd } : {}),
    ...(event.repoRoot ? { repo_root: event.repoRoot } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.permissionMode ? { permission_mode: event.permissionMode } : {}),
    ...(event.transcriptPath ? { transcript_path: event.transcriptPath } : {}),
    payload: event.payload
  };
}

function encodeOption(option: DecisionOption): Record<string, JsonValue> {
  return {
    id: option.id,
    text: option.text,
    ...(option.rationale ? { rationale: option.rationale } : {})
  };
}

function encodeDecision(record: DecisionRecord): Record<string, JsonValue> {
  return {
    id: record.id,
    kind: record.kind,
    context: record.context,
    ...(record.selectedOptionText ? { selected_option_text: record.selectedOptionText } : {}),
    ...(record.freeformResponse ? { freeform_response: record.freeformResponse } : {}),
    alternatives: record.alternatives.map(encodeOption),
    ...(record.permissionStatus ? { permission_status: record.permissionStatus } : {}),
    evidence: record.evidence,
    ...(record.consequences ? { consequences: record.consequences } : {})
  };
}

function encodeConstraint(record: ExternalConstraint): Record<string, JsonValue> {
  return {
    id: record.id,
    file_path: record.filePath,
    ...(record.startLine === undefined ? {} : { start_line: record.startLine }),
    ...(record.endLine === undefined ? {} : { end_line: record.endLine }),
    ...(record.excerpt ? { excerpt: record.excerpt } : {}),
    summary: record.summary,
    source: record.source
  };
}

export function encodeProvenanceSession(session: ProvenanceSession): Record<string, JsonValue> {
  return {
    ...(session.extra ?? {}),
    provider: session.provider,
    provider_display_name: session.providerDisplayName,
    session_id: session.sessionId,
    ...(session.turnId ? { turn_id: session.turnId } : {}),
    source: session.source,
    actor: session.actor,
    ...(session.human ? { human: session.human } : {}),
    ...(session.model ? { model: session.model } : {}),
    ...(session.permissionMode ? { permission_mode: session.permissionMode } : {}),
    ...(session.transcriptPath ? { transcript_path: session.transcriptPath } : {}),
    human_reviewer: session.humanReviewer,
    prompt: session.prompt,
    tools_used: session.toolsUsed,
    commands_run: session.commandsRun,
    files_edited: session.filesEdited,
    tests_run: session.testsRun,
    tests_result: session.testsResult,
    permission_requests: session.permissionRequests,
    decisions: session.decisions.map(encodeDecision),
    external_constraints: session.externalConstraints.map(encodeConstraint),
    last_assistant_message: session.lastAssistantMessage,
    git_diff: session.gitDiff,
    ...(session.commitSha ? { commit_sha: session.commitSha } : {}),
    ...(session.commitMessage ? { commit_message: session.commitMessage } : {}),
    reasoning_summary: session.reasoningSummary,
    line_ranges: session.lineRanges.map((range) => ({
      file: range.file,
      start: range.start,
      end: range.end,
      confidence: range.confidence,
      label: range.label
    })),
    ...(session.rawTelemetryPayload === undefined
      ? {}
      : { raw_telemetry_payload: session.rawTelemetryPayload })
  };
}

export const decodeLegacyEvent = decodeLineageEvent;
export const decodeLegacySession = decodeProvenanceSession;
export const encodeLegacyEvent = encodeLineageEvent;
export const encodeLegacySession = encodeProvenanceSession;
