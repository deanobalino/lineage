import { randomUUID } from "node:crypto";
import type {
  DecisionOption,
  ExternalConstraint,
  JsonValue,
  LineageEvent
} from "./models.js";
import { canonicalEventTypes, isJsonValue, providerDisplayName, providers } from "./models.js";

export interface AdapterContext {
  provider?: string;
  raw: Record<string, unknown>;
  payload?: Record<string, unknown>;
  cwd: string;
  repoRoot: string;
  environment?: Record<string, string | undefined>;
  capturedAt?: string;
  ingestionId?: string;
  gitSnapshot?: {
    status?: string;
    diff?: string;
    head?: string;
    changedFiles?: string[];
  };
}

function firstString(object: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function json(value: unknown): JsonValue | undefined {
  return isJsonValue(value) ? value : undefined;
}

function options(value: unknown): DecisionOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((candidate, index) => {
    if (typeof candidate === "string") return [{ id: `option-${index + 1}`, text: candidate }];
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    const text = firstString(item, ["text", "option", "label", "title"]);
    if (!text) return [];
    const result: DecisionOption = {
      id: firstString(item, ["id"]) ?? `option-${index + 1}`,
      text
    };
    const rationale = firstString(item, ["rationale", "reason", "summary"]);
    if (rationale) result.rationale = rationale;
    return [result];
  });
}

function constraints(value: unknown): ExternalConstraint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((candidate, index) => {
    if (typeof candidate === "string") {
      return [{
        id: `constraint-${index + 1}`,
        filePath: "Unknown",
        summary: candidate,
        source: "provider_payload"
      }];
    }
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    const summary = firstString(item, ["summary", "constraint", "text", "excerpt"]);
    if (!summary) return [];
    const result: ExternalConstraint = {
      id: firstString(item, ["id"]) ?? `constraint-${index + 1}`,
      filePath: firstString(item, ["file_path", "filePath", "path"]) ?? "Unknown",
      summary,
      source: firstString(item, ["source", "capture_source"]) ?? "provider_payload"
    };
    const start = item["start_line"] ?? item["startLine"] ?? item["line"];
    const end = item["end_line"] ?? item["endLine"];
    const excerpt = firstString(item, ["excerpt", "quote"]);
    if (typeof start === "number") result.startLine = start;
    if (typeof end === "number") result.endLine = end;
    if (excerpt) result.excerpt = excerpt;
    return [result];
  });
}

export function canonicalType(providerEventName: string): string {
  const normalized = providerEventName.replaceAll(/[_\s-]/g, "").toLowerCase();
  const mapping: Record<string, string> = {
    sessionstart: canonicalEventTypes.sessionStart,
    userpromptsubmit: canonicalEventTypes.prompt,
    prompt: canonicalEventTypes.prompt,
    pretooluse: canonicalEventTypes.preToolUse,
    posttooluse: canonicalEventTypes.postToolUse,
    assistantoptionspresented: canonicalEventTypes.assistantOptionsPresented,
    userdecision: canonicalEventTypes.userDecision,
    permissiondecision: canonicalEventTypes.permissionDecision,
    externalconstraint: canonicalEventTypes.externalConstraint,
    stop: canonicalEventTypes.sessionStop,
    sessionend: canonicalEventTypes.sessionStop
  };
  return mapping[normalized] ?? normalized;
}

export function canonicalEventType(provider: string, providerEventName: string): string {
  if (provider === providers.copilot.id && providerEventName === "Stop") {
    return canonicalEventTypes.agentStop;
  }
  return canonicalType(providerEventName);
}

export function canonicalEvent(context: AdapterContext): LineageEvent {
  const payload = context.payload ?? context.raw;
  const environment = context.environment ?? {};
  const provider = context.provider ?? firstString(context.raw, ["provider"]) ?? providers.codex.id;
  const providerEventName =
    firstString(context.raw, ["provider_event_name", "hook_event_name", "hookEventName", "event", "name"]) ??
    environment["LINEAGE_HOOK_EVENT"] ??
    "Unknown";
  const eventType =
    firstString(context.raw, ["event_type", "eventType"]) ??
    canonicalEventType(provider, providerEventName);

  const canonicalPayload: Record<string, JsonValue> = {};
  const aliases: Array<[string, string[]]> = [
    ["prompt", ["prompt", "user_prompt"]],
    ["tool_name", ["tool_name", "toolName", "tool"]],
    ["tool_use_id", ["tool_use_id", "toolUseID", "id"]],
    ["approval_reason", ["approval_reason", "approvalReason", "reason"]],
    ["approval_status", ["approval_status", "approvalStatus", "status", "decision"]],
    ["last_assistant_message", ["last_assistant_message", "lastAssistantMessage", "assistant_message"]],
    ["tests_result", ["tests_result", "testsResult"]],
    ["selected_option_text", ["selected_option_text", "selectedOptionText", "selected_option", "selection_text"]],
    ["freeform_response", ["freeform_response", "freeformResponse", "user_response", "response_text"]],
    ["decision_context", ["decision_context", "decisionContext", "context"]],
    ["decision_consequences", ["decision_consequences", "decisionConsequences", "consequences", "risk"]]
  ];
  for (const [target, keys] of aliases) {
    const value = firstString(payload, keys);
    if (value) canonicalPayload[target] = value;
  }
  const toolInput = json(payload["tool_input"] ?? payload["toolInput"] ?? payload["toolArgs"] ?? payload["input"]);
  const toolResponse = json(payload["tool_response"] ?? payload["toolResponse"] ?? payload["tool_result"] ?? payload["toolResult"] ?? payload["error"] ?? payload["response"]);
  if (toolInput !== undefined) canonicalPayload["tool_input"] = toolInput;
  if (toolResponse !== undefined) canonicalPayload["tool_response"] = toolResponse;
  canonicalPayload["git_status"] = firstString(payload, ["git_status", "gitStatus"]) ?? context.gitSnapshot?.status ?? "";
  canonicalPayload["git_diff"] = firstString(payload, ["git_diff", "gitDiff"]) ?? context.gitSnapshot?.diff ?? "";
  canonicalPayload["git_head"] = firstString(payload, ["git_head", "gitHead"]) ?? context.gitSnapshot?.head ?? "";
  const changedFiles = payload["changed_files"] ?? context.gitSnapshot?.changedFiles;
  if (Array.isArray(changedFiles)) canonicalPayload["changed_files"] = changedFiles.filter((item): item is string => typeof item === "string");
  const testsDetected = payload["tests_detected"];
  if (Array.isArray(testsDetected)) canonicalPayload["tests_detected"] = testsDetected.filter((item): item is string => typeof item === "string");
  const decisionOptions = options(payload["options_presented"] ?? payload["optionsPresented"] ?? payload["alternatives"]);
  if (decisionOptions) canonicalPayload["options_presented"] = decisionOptions as unknown as JsonValue;
  const externalConstraints = constraints(payload["external_constraints"] ?? payload["externalConstraints"] ?? payload["spec_references"] ?? payload["specReferences"]);
  if (externalConstraints) canonicalPayload["external_constraints"] = externalConstraints as unknown as JsonValue;
  canonicalPayload["raw_provider_payload"] = json(payload) ?? {};

  const sessionId =
    firstString(context.raw, ["session_id", "sessionID", "sessionId"]) ??
    environment["CODEX_SESSION_ID"] ??
    `${provider}-${Date.parse(context.capturedAt ?? "") || Date.now()}`;
  const event: LineageEvent = {
    id: context.ingestionId ?? randomUUID(),
    lineageSchemaVersion: "0.1",
    capturedAt: new Date(context.capturedAt ?? Date.now()).toISOString(),
    source: "provider-hook",
    provider,
    providerEventName,
    eventType,
    actor: providerDisplayName(provider),
    hookEventName: providerEventName,
    sessionId,
    cwd: context.cwd,
    repoRoot: context.repoRoot,
    payload: canonicalPayload
  };
  const optional: Array<[keyof LineageEvent, string | undefined]> = [
    ["human", firstString(context.raw, ["human", "user", "human_reviewer"])],
    ["turnId", firstString(context.raw, ["turn_id", "turnID", "turnId"]) ?? environment["CODEX_TURN_ID"]],
    ["model", firstString(context.raw, ["model"]) ?? environment["CODEX_MODEL"]],
    ["permissionMode", firstString(context.raw, ["permission_mode", "permissionMode"]) ?? environment["CODEX_PERMISSION_MODE"]],
    ["transcriptPath", firstString(context.raw, ["transcript_path", "transcriptPath"]) ?? environment["CODEX_TRANSCRIPT_PATH"]]
  ];
  for (const [key, value] of optional) if (value) Object.assign(event, { [key]: value });
  return event;
}
