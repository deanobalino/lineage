import type {
  AnonymousSession,
  AuthenticatedSession,
  ExplainQuery,
  ExportKind,
  ExportQuery,
  FollowUpRequest,
  Provider,
  RepositoryCaptureResponse
} from "../shared/api-contracts.js";
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
const unauthorizedListeners = new Set<() => void>();

function queryString(
  values: Record<string, string | number | undefined>
): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  return query;
}

async function response(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal
): Promise<Response> {
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
  const result = await fetch(path, requestInit);
  if (!result.ok) {
    if (result.status === 401) {
      csrf = "";
      for (const listener of unauthorizedListeners) listener();
    }
    const fallback = `Request failed (${result.status}).`;
    const error = await result.json().catch(() => ({})) as {
      message?: string;
      error?: string;
    };
    throw new ApiError(error.message ?? fallback, result.status, error.error);
  }
  return result;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal
): Promise<T> {
  return (await response(path, init, signal)).json() as Promise<T>;
}

async function download(path: string): Promise<void> {
  const result = await response(path);
  const blob = await result.blob();
  const disposition = result.headers.get("content-disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "lineage-export";
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const api = {
  onUnauthorized(listener: () => void) {
    unauthorizedListeners.add(listener);
    return () => {
      unauthorizedListeners.delete(listener);
    };
  },
  async session() {
    const result = await request<AuthenticatedSession>(
      "/api/v1/auth/session"
    );
    csrf = result.csrf;
    return result;
  },
  async login(token: string) {
    const result = await request<AuthenticatedSession>(
      "/api/v1/auth/login",
      { method: "POST", body: JSON.stringify({ token }) }
    );
    csrf = result.csrf;
    return result;
  },
  async logout() {
    const result = await request<AnonymousSession>("/api/v1/auth/logout", {
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
  explain: (id: string, selection: ExplainQuery, signal?: AbortSignal) =>
    request<LineExplanation>(
      `/api/v1/repositories/${encodeURIComponent(id)}/explain?${queryString(selection)}`,
      {},
      signal
    ),
  sessions: (id: string, signal?: AbortSignal) =>
    request<{ sessions: SessionSummary[] }>(
      `/api/v1/repositories/${encodeURIComponent(id)}/sessions`,
      {},
      signal
    ),
  sessionDetail: (
    id: string,
    provider: Provider,
    sessionId: string,
    signal?: AbortSignal
  ) =>
    request<SessionDetail>(
      `/api/v1/repositories/${encodeURIComponent(id)}/sessions/${encodeURIComponent(provider)}/${encodeURIComponent(sessionId)}`,
      {},
      signal
    ),
  followUp: (id: string, followUp: FollowUpRequest) =>
    request<{ answer: string }>(
      `/api/v1/repositories/${encodeURIComponent(id)}/follow-up`,
      { method: "POST", body: JSON.stringify(followUp) }
    ),
  captureStatus: (signal?: AbortSignal) =>
    request<CaptureHealth>("/api/v1/capture/status", {}, signal),
  repositoryCapture: (id: string, signal?: AbortSignal) =>
    request<RepositoryCaptureResponse>(
      `/api/v1/repositories/${encodeURIComponent(id)}/capture`,
      {},
      signal
    ),
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
    kind: ExportKind,
    options: Omit<ExportQuery, "kind"> = {}
  ) {
    const query = queryString({ kind, ...options });
    return `/api/v1/repositories/${encodeURIComponent(id)}/export?${query}`;
  },
  download
};
