export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const providers = {
  codex: { id: "codex", displayName: "Codex" },
  copilot: { id: "github-copilot", displayName: "GitHub Copilot CLI" }
} as const;

export const canonicalEventTypes = {
  sessionStart: "session_start",
  prompt: "prompt",
  preToolUse: "pre_tool_use",
  postToolUse: "post_tool_use",
  assistantOptionsPresented: "assistant_options_presented",
  userDecision: "user_decision",
  permissionDecision: "permission_decision",
  externalConstraint: "external_constraint",
  agentStop: "agent_stop",
  sessionStop: "session_stop"
} as const;

export interface DecisionOption {
  id: string;
  text: string;
  rationale?: string;
}

export interface ExternalConstraint {
  id: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  excerpt?: string;
  summary: string;
  source: string;
}

export interface DecisionRecord {
  id: string;
  kind: string;
  context: string;
  selectedOptionText?: string;
  freeformResponse?: string;
  alternatives: DecisionOption[];
  permissionStatus?: string;
  evidence: string[];
  consequences?: string;
}

export interface LineRange {
  file: string;
  start: number;
  end: number;
  confidence: number;
  label: string;
}

export interface LineageEvent {
  id: string;
  lineageSchemaVersion: string;
  capturedAt: string;
  providerSequence?: number;
  source: string;
  provider: string;
  providerEventName: string;
  eventType: string;
  actor: string;
  human?: string;
  hookEventName: string;
  sessionId: string;
  turnId?: string;
  cwd?: string;
  repoRoot?: string;
  model?: string;
  permissionMode?: string;
  transcriptPath?: string;
  payload: Record<string, JsonValue>;
}

export interface ProvenanceSession {
  provider: string;
  providerDisplayName: string;
  sessionId: string;
  turnId?: string;
  source: string;
  actor: string;
  human?: string;
  model?: string;
  permissionMode?: string;
  transcriptPath?: string;
  humanReviewer: string;
  prompt: string;
  toolsUsed: string[];
  commandsRun: string[];
  filesEdited: string[];
  testsRun: string[];
  testsResult: string;
  permissionRequests: string[];
  decisions: DecisionRecord[];
  externalConstraints: ExternalConstraint[];
  lastAssistantMessage: string;
  gitDiff: string;
  commitSha?: string;
  commitMessage?: string;
  reasoningSummary: string;
  lineRanges: LineRange[];
  rawTelemetryPayload?: JsonValue;
  extra?: Record<string, JsonValue>;
}

export interface GitLineEvidence {
  commitSha: string;
  commitSummary: string;
  author: string;
  authorEmail?: string;
  authoredAt?: string;
  line: number;
  content: string;
}

export interface ArchitectureDecision {
  context: string;
  decision: string;
  alternatives: DecisionOption[];
  evidence: string[];
  consequences: string;
  externalConstraints: ExternalConstraint[];
}

export interface DecisionProvenance {
  label: string;
  detail: string;
  evidence: string[];
}

export interface LineExplanation {
  file: string;
  line: number;
  answer: string;
  confidence: number;
  provider?: string;
  sessionId?: string;
  gitEvidence?: GitLineEvidence;
  decisionProvenance: DecisionProvenance;
  architectureDecision?: ArchitectureDecision;
  timeline: string[];
  evidenceCards: Array<{ id: string; title: string; kind: string; body: string }>;
  removalAssessment: string;
  suggestedQuestions: string[];
}

export function providerDisplayName(provider: string): string {
  if (provider === providers.codex.id) return providers.codex.displayName;
  if (provider === providers.copilot.id) return providers.copilot.displayName;
  return provider || "Unknown";
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    typeof value === "object" &&
    Object.values(value as Record<string, unknown>).every(isJsonValue)
  );
}
