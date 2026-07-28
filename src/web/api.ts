import type {
  CaptureHealth,
  Diff,
  LineExplanation,
  Repository,
  RepositoryContext,
  Review,
  SessionDetail,
  SessionSummary,
  SourceResponse
} from "./types.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "request_failed"
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let csrf = "";

async function request<T>(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (csrf && !["GET", "HEAD"].includes(init.method ?? "GET")) {
    headers.set("x-csrf-token", csrf);
  }
  const requestInit: RequestInit = {
    ...init,
    headers,
    credentials: "same-origin"
  };
  if (signal) requestInit.signal = signal;
  const response = await fetch(path, requestInit);
  if (!response.ok) {
    const fallback = `Request failed (${response.status}).`;
    const error = await response.json().catch(() => ({})) as {
      message?: string;
      error?: string;
    };
    throw new ApiError(error.message ?? fallback, response.status, error.error);
  }
  return response.json() as Promise<T>;
}

export const api = {
  async session() {
    const result = await request<{ authenticated: true; csrf: string; expiresAt: number }>(
      "/api/v1/auth/session"
    );
    csrf = result.csrf;
    return result;
  },
  async login(token: string) {
    const result = await request<{ authenticated: true; csrf: string; expiresAt: number }>(
      "/api/v1/auth/login",
      { method: "POST", body: JSON.stringify({ token }) }
    );
    csrf = result.csrf;
    return result;
  },
  async logout() {
    const result = await request<{ authenticated: false }>("/api/v1/auth/logout", {
      method: "POST"
    });
    csrf = "";
    return result;
  },
  repositories: (signal?: AbortSignal) =>
    request<{ repositories: Repository[] }>("/api/v1/repositories", {}, signal),
  addRepository: (path: string) =>
    request<{ repository: Repository }>("/api/v1/repositories", {
      method: "POST",
      body: JSON.stringify({ path })
    }),
  removeRepository: (id: string) =>
    request<{ removed: boolean; repositoryDataDeleted: false }>(
      `/api/v1/repositories/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    ),
  createDemo: () =>
    request<{ repository: Repository; reset: true }>("/api/v1/demo/reset", {
      method: "POST"
    }),
  repository: (id: string, signal?: AbortSignal) =>
    request<RepositoryContext>(`/api/v1/repositories/${encodeURIComponent(id)}`, {}, signal),
  refresh: (id: string) =>
    request<{ refreshed: true; sessions: number }>(
      `/api/v1/repositories/${encodeURIComponent(id)}/refresh`,
      { method: "POST" }
    ),
  switchBranch: (id: string, branch: string) =>
    request<{ currentBranch: string | null }>(
      `/api/v1/repositories/${encodeURIComponent(id)}/branch`,
      { method: "POST", body: JSON.stringify({ branch }) }
    ),
  review: (id: string, base: string, signal?: AbortSignal) =>
    request<Review>(
      `/api/v1/repositories/${encodeURIComponent(id)}/review?${new URLSearchParams({ base })}`,
      {},
      signal
    ),
  diff: (id: string, base: string, path: string, signal?: AbortSignal) =>
    request<Diff>(
      `/api/v1/repositories/${encodeURIComponent(id)}/diff?${new URLSearchParams({ base, path })}`,
      {},
      signal
    ),
  files: (id: string, signal?: AbortSignal) =>
    request<{ files: string[] }>(
      `/api/v1/repositories/${encodeURIComponent(id)}/files`,
      {},
      signal
    ),
  source: (id: string, path: string, signal?: AbortSignal) =>
    request<SourceResponse>(
      `/api/v1/repositories/${encodeURIComponent(id)}/source?${new URLSearchParams({ path })}`,
      {},
      signal
    ),
  explain: (id: string, path: string, line: number, signal?: AbortSignal) =>
    request<LineExplanation>(
      `/api/v1/repositories/${encodeURIComponent(id)}/explain?${new URLSearchParams({
        path,
        line: String(line)
      })}`,
      {},
      signal
    ),
  sessions: (id: string, signal?: AbortSignal) =>
    request<{ sessions: SessionSummary[] }>(
      `/api/v1/repositories/${encodeURIComponent(id)}/sessions`,
      {},
      signal
    ),
  sessionDetail: (id: string, sessionId: string, signal?: AbortSignal) =>
    request<SessionDetail>(
      `/api/v1/repositories/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}`,
      {},
      signal
    ),
  followUp: (id: string, path: string, line: number, question: string) =>
    request<{ answer: string }>(
      `/api/v1/repositories/${encodeURIComponent(id)}/follow-up`,
      { method: "POST", body: JSON.stringify({ path, line, question }) }
    ),
  captureStatus: (signal?: AbortSignal) =>
    request<CaptureHealth>("/api/v1/capture/status", {}, signal),
  repositoryCapture: (id: string, signal?: AbortSignal) =>
    request<{
      harnesses: Array<{
        provider: "codex" | "github-copilot";
        configured: boolean;
        configurationPath: string;
      }>;
      health: CaptureHealth;
    }>(`/api/v1/repositories/${encodeURIComponent(id)}/capture`, {}, signal),
  installCapture: (id: string, provider: "codex" | "github-copilot") =>
    request<unknown>(`/api/v1/repositories/${encodeURIComponent(id)}/capture/install`, {
      method: "POST",
      body: JSON.stringify({ provider })
    }),
  replayCapture: () =>
    request<unknown>("/api/v1/capture/replay", { method: "POST" }),
  deadLetters: (action: "retry" | "discard") =>
    request<unknown>("/api/v1/capture/deadletters", {
      method: "POST",
      body: JSON.stringify({ action })
    }),
  acknowledgeIncomplete: () =>
    request<unknown>("/api/v1/capture/incomplete/acknowledge", { method: "POST" }),
  recoverCodex: (id: string) =>
    request<unknown>(`/api/v1/repositories/${encodeURIComponent(id)}/capture/recover-codex`, {
      method: "POST"
    }),
  exportUrl(
    id: string,
    kind: "session-markdown" | "session-json" | "agent-trace" | "explanation",
    options: { session?: string; path?: string; line?: number } = {}
  ) {
    const query = new URLSearchParams({ kind });
    if (options.session) query.set("session", options.session);
    if (options.path) query.set("path", options.path);
    if (options.line) query.set("line", String(options.line));
    return `/api/v1/repositories/${encodeURIComponent(id)}/export?${query}`;
  }
};
