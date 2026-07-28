import { randomUUID } from "node:crypto";
import type { JsonValue } from "../domain/models.js";
import { isJsonValue } from "../domain/models.js";
import { canonicalEventType } from "../domain/provider-adapters.js";

export const CAPTURE_ENVELOPE_VERSION = 1;
export const MAX_CAPTURE_INPUT_BYTES = 1024 * 1024;
export const MAX_CAPTURE_RECORD_BYTES = 2 * 1024 * 1024;

export interface GitSnapshot {
  head: string;
  status: string;
  diff: string;
  changedFiles: string[];
  complete: boolean;
  truncated: boolean;
  error?: string;
}

export interface CaptureEnvelope {
  version: 1;
  ingestionId: string;
  capturedAt: string;
  provider: string;
  providerEventName: string;
  eventType: string;
  providerSequence?: number;
  sessionId: string;
  turnId?: string;
  cwd: string;
  repoRoot: string;
  raw: Record<string, JsonValue>;
  environment: Record<string, string>;
  gitSnapshot?: GitSnapshot;
  evidenceComplete: boolean;
  evidenceIssue?: string;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(object: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export interface EnvelopeInput {
  input: unknown;
  provider?: string;
  providerEventName?: string;
  cwd: string;
  repoRoot: string;
  environment?: Record<string, string | undefined>;
  ingestionId?: string;
  capturedAt?: string;
}

export function createEnvelope(input: EnvelopeInput): CaptureEnvelope {
  const rawInput = object(input.input);
  const raw: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(rawInput)) {
    if (isJsonValue(value)) raw[key] = value;
  }
  const environment = input.environment ?? {};
  const provider =
    input.provider ??
    firstString(rawInput, ["provider"]) ??
    environment["LINEAGE_PROVIDER"] ??
    "codex";
  const providerEventName =
    input.providerEventName ??
    firstString(rawInput, [
      "provider_event_name",
      "hook_event_name",
      "hookEventName",
      "event",
      "name"
    ]) ??
    environment["LINEAGE_HOOK_EVENT"] ??
    "Unknown";
  const sessionId =
    firstString(rawInput, ["session_id", "sessionID", "sessionId"]) ??
    environment["CODEX_SESSION_ID"] ??
    `${provider}-${Date.now()}`;
  const envelope: CaptureEnvelope = {
    version: CAPTURE_ENVELOPE_VERSION,
    ingestionId: input.ingestionId ?? randomUUID(),
    capturedAt: new Date(input.capturedAt ?? Date.now()).toISOString(),
    provider,
    providerEventName,
    eventType: canonicalEventType(provider, providerEventName),
    sessionId,
    cwd: input.cwd,
    repoRoot: input.repoRoot,
    raw,
    environment: Object.fromEntries(
      [
        "CODEX_MODEL",
        "CODEX_PERMISSION_MODE",
        "CODEX_TRANSCRIPT_PATH",
        "LINEAGE_HOOK_EVENT",
        "LINEAGE_PROVIDER"
      ].flatMap((key) => {
        const value = environment[key];
        return value ? [[key, value]] : [];
      })
    ),
    evidenceComplete: false,
    evidenceIssue: "Git evidence has not been collected."
  };
  const providerSequence = rawInput["provider_sequence"] ?? rawInput["providerSequence"];
  if (typeof providerSequence === "number" && Number.isFinite(providerSequence)) {
    envelope.providerSequence = providerSequence;
  }
  const turnId =
    firstString(rawInput, ["turn_id", "turnID", "turnId"]) ??
    environment["CODEX_TURN_ID"];
  if (turnId) envelope.turnId = turnId;
  return envelope;
}

export function validateEnvelope(value: unknown): CaptureEnvelope {
  const item = object(value);
  if (
    item["version"] !== 1 ||
    typeof item["ingestionId"] !== "string" ||
    !/^[A-Za-z0-9._:-]{1,200}$/.test(item["ingestionId"]) ||
    typeof item["capturedAt"] !== "string" ||
    Number.isNaN(Date.parse(item["capturedAt"])) ||
    typeof item["provider"] !== "string" ||
    typeof item["providerEventName"] !== "string" ||
    typeof item["eventType"] !== "string" ||
    typeof item["sessionId"] !== "string" ||
    typeof item["cwd"] !== "string" ||
    typeof item["repoRoot"] !== "string" ||
    !isJsonValue(item["raw"]) ||
    !isJsonValue(item["environment"]) ||
    typeof item["evidenceComplete"] !== "boolean"
  ) {
    throw new Error("Capture envelope is invalid.");
  }
  if (
    item["providerSequence"] !== undefined &&
    (typeof item["providerSequence"] !== "number" ||
      !Number.isFinite(item["providerSequence"]))
  ) {
    throw new Error("Capture envelope provider sequence is invalid.");
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > MAX_CAPTURE_RECORD_BYTES) {
    throw new Error("Capture envelope exceeds the record limit.");
  }
  return value as CaptureEnvelope;
}

export function isLifecycleBoundary(envelope: CaptureEnvelope): boolean {
  return envelope.eventType === "session_start" || envelope.eventType === "session_stop";
}
