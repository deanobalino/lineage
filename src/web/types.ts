export interface Repository {
  id: string;
  root: string;
  name: string;
  addedAt: string;
  lastOpenedAt: string;
  available: boolean;
  reason?: string;
}

export interface GitBranch {
  name: string;
  fullName: string;
  sha: string;
  remote: boolean;
  upstream?: string;
}

export interface RepositoryContext {
  repository: Repository;
  branches: GitBranch[];
  currentBranch: string | null;
  defaultBase: string | null;
}

export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown";
  additions: number;
  deletions: number;
  binary: boolean;
  providers: string[];
}

export interface ReviewMetrics {
  commits: number;
  files: number;
  additions: number;
  deletions: number;
  sessions: number;
  explainedPercent: number;
}

export interface Review {
  base: string;
  mergeBase: string;
  commits: Array<{
    sha: string;
    shortSha: string;
    author: string;
    authoredAt: string;
    subject: string;
  }>;
  files: ChangedFile[];
  metrics: ReviewMetrics;
}

export interface DiffLine {
  kind: "context" | "addition" | "deletion" | "meta";
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface DiffHunk {
  id: string;
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface SessionSummary {
  provider: string;
  providerDisplayName: string;
  sessionId: string;
  prompt: string;
  filesEdited: string[];
  testsResult: string;
  commitSha: string | null;
  lineRanges: Array<{
    file: string;
    start: number;
    end: number;
    confidence: number;
    label: string;
  }>;
}

export interface Diff {
  path: string;
  raw: string;
  hunks: DiffHunk[];
  sessions: SessionSummary[];
}

export interface DecisionOption {
  id: string;
  text: string;
  rationale?: string;
}

export interface LineExplanation {
  file: string;
  line: number;
  answer: string;
  confidence: number;
  provider?: string;
  sessionId?: string;
  gitEvidence?: {
    commitSha: string;
    commitSummary: string;
    author: string;
    authorEmail?: string;
    authoredAt?: string;
    line: number;
    content: string;
  };
  decisionProvenance: {
    label: string;
    detail: string;
    evidence: string[];
  };
  architectureDecision?: {
    context: string;
    decision: string;
    alternatives: DecisionOption[];
    evidence: string[];
    consequences: string;
    externalConstraints: Array<{
      id: string;
      filePath: string;
      startLine?: number;
      endLine?: number;
      excerpt?: string;
      summary: string;
      source: string;
    }>;
  };
  timeline: string[];
  evidenceCards: Array<{ id: string; title: string; kind: string; body: string }>;
  removalAssessment: string;
  suggestedQuestions: string[];
}

export interface CaptureHealth {
  state: "off" | "installed" | "healthy" | "interrupted" | "pending" | "replaying" | "degraded";
  pending: number;
  claimed: number;
  deadLetters: number;
  incompleteEvidence: number;
  lastSuccessAt?: string;
  lastError?: string;
}

export interface SourceResponse {
  path: string;
  revision: string;
  offset: number;
  total: number;
  truncated: boolean;
  lines: Array<{ number: number; text: string }>;
}

export interface SessionDetail {
  session: Record<string, unknown> & {
    sessionId: string;
    providerDisplayName: string;
    prompt: string;
    testsRun: string[];
    testsResult: string;
    commandsRun: string[];
    toolsUsed: string[];
    decisions: unknown[];
    externalConstraints: unknown[];
  };
  evidence: {
    timeline?: unknown[];
    transcript?: string;
    [key: string]: unknown;
  };
  graph: {
    nodes: unknown[];
    edges: unknown[];
  };
}
