import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { Type } from "@sinclair/typebox";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  agentTraceJsonl,
  agentTraceRecords,
  answerFollowUp,
  buildProvenanceGraph,
  explainLine,
  explanationMarkdown,
  linkRepository,
  loadSessionEvidence,
  MAX_GRAPH_EVENTS,
  MAX_GRAPH_SESSIONS,
  ProvenanceStore,
  recoverCodexTranscripts,
  sessionEvidenceJson,
  sessionEvidenceMarkdown,
  validateCodexTranscriptIdentity,
  type ProvenanceSession
} from "../domain/index.js";
import { writeCaptureClientConfig } from "../capture/client.js";
import { atomicWrite } from "../domain/provenance-store.js";
import {
  harnessStatus,
  installCaptureExecutable,
  installHarness,
  type HarnessProvider
} from "../capture/hooks.js";
import { CredentialStore, type BootstrapSecrets } from "./access/credentials.js";
import {
  LoginThrottle,
  SessionStore,
  type OperatorSession
} from "./access/sessions.js";
import type { ServerConfig } from "./config.js";
import { resetDemoRepository } from "./demo/demo-repository.js";
import { buildCaptureApp } from "./capture/capture-app.js";
import { CaptureService } from "./capture/capture-service.js";
import { GitError, GitService } from "./git/git-service.js";
import {
  parseBlame,
  parseUnifiedDiff,
  reviewMetrics,
  sessionsForFile
} from "./git/review.js";
import {
  RepositoryError,
  RepositoryRegistry
} from "./repositories/registry.js";
import {
  AnonymousSessionSchema,
  AuthenticatedSessionSchema,
  ErrorResponseSchema,
  ExplainQuerySchema,
  ExportQuerySchema,
  FollowUpRequestSchema,
  ProviderSchema,
  RepositoryCaptureResponseSchema,
  type ExplainQuery,
  type ExportQuery,
  type FollowUpRequest,
  type RepositoryCaptureResponse
} from "../shared/api-contracts.js";
import { withinPath } from "../shared/path-safety.js";
import { serializeByKey } from "../shared/serialization.js";

const IdParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }) });
const SessionParams = Type.Intersect([
  IdParams,
  Type.Object({
    provider: ProviderSchema,
    sessionId: Type.String({ minLength: 1, maxLength: 512 })
  })
]);

export interface AppServices {
  credentials: CredentialStore;
  sessions: SessionStore;
  registry: RepositoryRegistry;
  git: GitService;
  capture: CaptureService;
}

export interface BuiltApp {
  app: FastifyInstance;
  captureApp: FastifyInstance;
  bootstrap: BootstrapSecrets;
  services: AppServices;
}

function bearerCookie(request: FastifyRequest): string | undefined {
  return request.cookies["lineage_session"];
}

function safeName(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

async function resolveLineMaterial(
  git: GitService,
  repoRoot: string,
  selection: ExplainQuery
): Promise<{ path: string; revision: string; source: string; blame: string }> {
  if ((selection.side ?? "new") === "new") {
    return {
      path: selection.path,
      revision: "HEAD",
      source: await git.source(repoRoot, selection.path, "HEAD"),
      blame: await git.blame(repoRoot, selection.path, selection.line, "HEAD")
    };
  }
  if (!selection.base) {
    throw new GitError("A base branch is required for an old-side line.", 1, "");
  }
  const changed = await git.changedFiles(repoRoot, selection.base);
  const file = changed.find((candidate) => candidate.path === selection.path);
  if (!file) {
    throw new GitError("The requested path is not changed against the selected base.", 1, "");
  }
  const oldPath = file.previousPath ?? file.path;
  if (selection.previousPath && selection.previousPath !== oldPath) {
    throw new GitError("The previous path does not match the selected changed file.", 1, "");
  }
  const revision = await git.mergeBase(repoRoot, selection.base);
  const source = (
    await git.run(repoRoot, ["show", `${revision}:${oldPath}`])
  ).stdout;
  const blame = (
    await git.run(repoRoot, [
      "blame",
      "--line-porcelain",
      "-L",
      `${selection.line},${selection.line}`,
      revision,
      "--",
      oldPath
    ])
  ).stdout;
  return { path: oldPath, revision, source, blame };
}

export async function buildApp(config: ServerConfig): Promise<BuiltApp> {
  const app = Fastify({
    logger: {
      level: process.env["LINEAGE_LOG_LEVEL"] ?? "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers.x-csrf-token",
          "body.token",
          "body.credential"
        ],
        censor: "[REDACTED]"
      }
    },
    bodyLimit: 1024 * 1024,
    trustProxy: ["127.0.0.1", "::1"]
  });
  await app.register(cookie);

  const credentials = new CredentialStore(config.stateDirectory);
  const bootstrap = await credentials.initialize();
  const sessions = new SessionStore(config.sessionTtlMs);
  const throttle = new LoginThrottle();
  const git = new GitService(config.gitTimeoutMs, config.gitMaxBytes);
  const demosRoot = join(config.stateDirectory, "demos");
  await mkdir(demosRoot, { recursive: true, mode: 0o700 });
  const registry = new RepositoryRegistry(
    config.stateDirectory,
    [...config.allowedRoots, demosRoot],
    git
  );
  await registry.initialize();
  const capture = new CaptureService(config.stateDirectory, registry);
  await capture.initialize();
  const captureApp = buildCaptureApp(credentials, capture);
  const requestSessions = new WeakMap<FastifyRequest, OperatorSession>();
  const repositoryMutations = new Map<string, Promise<void>>();
  const publicPaths = new Set(["/api/v1/health", "/api/v1/auth/login"]);

  app.addHook("onRequest", async (request, reply) => {
    reply.headers({
      "content-security-policy":
        "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "permissions-policy": "camera=(), microphone=(), geolocation=()"
    });
    const path = request.url.split("?")[0] ?? request.url;
    if (path.startsWith("/api/")) reply.header("cache-control", "no-store");

    if (!config.allowedHosts.includes(request.hostname)) {
      return reply.code(400).send({ error: "invalid_host", message: "Host is not allowed." });
    }
    const origin = request.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) {
      return reply.code(403).send({ error: "invalid_origin", message: "Origin is not allowed." });
    }
    if (!path.startsWith("/api/v1") || publicPaths.has(path)) return;
    const session = sessions.get(bearerCookie(request));
    if (!session) {
      return reply.code(401).send({ error: "unauthorized", message: "Operator login required." });
    }
    requestSessions.set(request, session);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const csrf = request.headers["x-csrf-token"];
      if (csrf !== session.csrf) {
        return reply.code(403).send({ error: "invalid_csrf", message: "CSRF token is missing or invalid." });
      }
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      error.statusCode === 413
    ) {
      void reply.code(413).send({ error: "payload_too_large", message: "Request body exceeds the configured limit." });
      return;
    }
    if (
      error &&
      typeof error === "object" &&
      "validation" in error &&
      error.validation
    ) {
      void reply.code(400).send({ error: "invalid_request", message: "Request validation failed." });
      return;
    }
    if (error instanceof GitError) {
      void reply.code(400).send({ error: "git_error", message: error.message });
      return;
    }
    if (error instanceof RepositoryError) {
      const status = error.message === "Unknown repository." ? 404 : 400;
      void reply.code(status).send({ error: "repository_error", message: error.message });
      return;
    }
    app.log.error({ err: error }, "request failed");
    void reply.code(500).send({ error: "internal_error", message: "The request could not be completed." });
  });

  app.get("/api/v1/health", {
    schema: {
      response: {
        200: Type.Object({
          status: Type.Literal("ok"),
          version: Type.String()
        })
      }
    }
  }, async () => ({ status: "ok" as const, version: "0.2.0" }));

  app.post("/api/v1/auth/login", {
    schema: {
      body: Type.Object({ token: Type.String({ minLength: 20, maxLength: 512 }) }),
      response: {
        200: AuthenticatedSessionSchema,
        401: ErrorResponseSchema,
        429: ErrorResponseSchema
      }
    }
  }, async (request, reply) => {
    const key = request.ip;
    if (!throttle.allowed(key)) {
      return reply.code(429).send({
        error: "login_throttled",
        message: "Too many failed login attempts."
      });
    }
    const body = request.body as { token: string };
    if (!await credentials.verifyOperator(body.token)) {
      throttle.fail(key);
      return reply.code(401).send({ error: "invalid_token", message: "Token is invalid." });
    }
    throttle.clear(key);
    const session = sessions.create();
    reply.setCookie("lineage_session", session.id, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      expires: new Date(session.expiresAt)
    });
    return { authenticated: true as const, csrf: session.csrf, expiresAt: session.expiresAt };
  });

  app.get("/api/v1/auth/session", {
    schema: { response: { 200: AuthenticatedSessionSchema } }
  }, async (request) => {
    const session = requestSessions.get(request)!;
    return { authenticated: true as const, csrf: session.csrf, expiresAt: session.expiresAt };
  });

  app.post("/api/v1/auth/logout", {
    schema: { response: { 200: AnonymousSessionSchema } }
  }, async (request, reply) => {
    sessions.revoke(bearerCookie(request));
    reply.clearCookie("lineage_session", { path: "/" });
    return { authenticated: false as const };
  });

  app.post("/api/v1/auth/rotate", {
    schema: {
      body: Type.Object({
        credential: Type.Union([Type.Literal("operator"), Type.Literal("capture")])
      })
    }
  }, async (request, reply) => {
    const body = request.body as { credential: "operator" | "capture" };
    const secret =
      body.credential === "operator"
        ? await credentials.rotateOperator()
        : await credentials.rotateCapture();
    if (body.credential === "operator") {
      sessions.revokeAll();
      reply.clearCookie("lineage_session", { path: "/" });
    }
    return { credential: body.credential, token: secret, displayedOnce: true };
  });

  app.get("/api/v1/repositories", async () => ({ repositories: await registry.list() }));

  app.get("/api/v1/repositories/browse", {
    schema: {
      querystring: Type.Object({
        path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 }))
      })
    }
  }, async (request) => {
    const query = request.query as { path?: string };
    return {
      roots: registry.allowedRoots,
      path: query.path ?? registry.allowedRoots[0],
      entries: await registry.browse(query.path)
    };
  });

  app.post("/api/v1/repositories", {
    schema: {
      body: Type.Object({ path: Type.String({ minLength: 1, maxLength: 4096 }) })
    }
  }, async (request, reply) => {
    const record = await registry.add((request.body as { path: string }).path);
    const store = new ProvenanceStore(record.root);
    await linkRepository(store);
    return reply.code(201).send({ repository: record });
  });

  app.delete("/api/v1/repositories/:id", {
    schema: { params: IdParams }
  }, async (request, reply) => {
    const removed = await registry.remove((request.params as { id: string }).id);
    return removed
      ? { removed: true, repositoryDataDeleted: false }
      : reply.code(404).send({ error: "not_found", message: "Repository is not remembered." });
  });

  app.get("/api/v1/repositories/:id", {
    schema: { params: IdParams }
  }, async (request) => {
    const record = await repository(request, registry);
    const branches = await git.branches(record.root);
    const currentBranch = await git.currentBranch(record.root);
    return {
      repository: record,
      branches,
      currentBranch: currentBranch ?? null,
      defaultBase: git.defaultBase(branches, currentBranch) ?? null
    };
  });

  app.post("/api/v1/repositories/:id/refresh", {
    schema: { params: IdParams }
  }, async (request) => {
    const record = await repository(request, registry);
    const linked = await serializeByKey(repositoryMutations, record.id, async () => {
      const result = await linkRepository(new ProvenanceStore(record.root));
      await registry.touch(record.id);
      return result;
    });
    return { refreshed: true, sessions: linked.length };
  });

  app.post("/api/v1/repositories/:id/branch", {
    schema: {
      params: IdParams,
      body: Type.Object({ branch: Type.String({ minLength: 1, maxLength: 512 }) })
    }
  }, async (request) => {
    const record = await repository(request, registry);
    await serializeByKey(repositoryMutations, record.id, () =>
      git.switchBranch(record.root, (request.body as { branch: string }).branch)
    );
    return { currentBranch: await git.currentBranch(record.root) };
  });

  app.get("/api/v1/repositories/:id/review", {
    schema: {
      params: IdParams,
      querystring: Type.Object({ base: Type.String({ minLength: 1, maxLength: 512 }) })
    }
  }, async (request) => {
    const record = await repository(request, registry);
    const base = (request.query as { base: string }).base;
    const files = await git.changedFiles(record.root, base);
    const sessions = await new ProvenanceStore(record.root).sessions();
    return {
      base,
      mergeBase: await git.mergeBase(record.root, base),
      commits: await git.branchCommits(record.root, base),
      files: files.map((file) => ({
        ...file,
        providers: [
          ...new Set(sessionsForFile(sessions, file.path).map((session) => session.providerDisplayName))
        ].sort()
      })),
      metrics: await reviewMetrics(git, record.root, base, files, sessions)
    };
  });

  app.get("/api/v1/repositories/:id/diff", {
    schema: {
      params: IdParams,
      querystring: Type.Object({
        base: Type.String({ minLength: 1, maxLength: 512 }),
        path: Type.String({ minLength: 1, maxLength: 4096 })
      })
    }
  }, async (request) => {
    const record = await repository(request, registry);
    const query = request.query as { base: string; path: string };
    const raw = await git.diff(record.root, query.base, query.path);
    const sessions = sessionsForFile(
      await new ProvenanceStore(record.root).sessions(),
      query.path
    );
    return {
      path: query.path,
      raw,
      hunks: parseUnifiedDiff(raw),
      sessions: sessions.map(sessionSummary)
    };
  });

  app.get("/api/v1/repositories/:id/files", {
    schema: { params: IdParams }
  }, async (request) => {
    const record = await repository(request, registry);
    return { files: await git.trackedFiles(record.root) };
  });

  app.get("/api/v1/repositories/:id/source", {
    schema: {
      params: IdParams,
      querystring: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 4096 }),
        revision: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 }))
      })
    }
  }, async (request) => {
    const record = await repository(request, registry);
    const query = request.query as {
      path: string;
      revision?: string;
      offset?: number;
      limit?: number;
    };
    const source = await git.source(record.root, query.path, query.revision ?? "HEAD");
    const all = source.split(/\r?\n/);
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 500;
    return {
      path: query.path,
      revision: query.revision ?? "HEAD",
      offset,
      total: all.length,
      truncated: offset + limit < all.length,
      lines: all.slice(offset, offset + limit).map((text, index) => ({
        number: offset + index + 1,
        text
      }))
    };
  });

  app.get("/api/v1/repositories/:id/explain", {
    schema: {
      params: IdParams,
      querystring: ExplainQuerySchema
    }
  }, async (request) => {
    const record = await repository(request, registry);
    const query = request.query as ExplainQuery;
    const material = await resolveLineMaterial(git, record.root, {
      path: query.path,
      line: query.line,
      ...(query.base ? { base: query.base } : {}),
      ...(query.side ? { side: query.side } : {}),
      ...(query.previousPath ? { previousPath: query.previousPath } : {})
    });
    const lineText = material.source.split(/\r?\n/)[query.line - 1] ?? "";
    const evidence = parseBlame(material.blame, query.line, lineText);
    const sessions = await new ProvenanceStore(record.root).matchingSessions(
      material.path,
      query.line,
      evidence.commitSha
    );
    const explanation = explainLine({
      file: material.path,
      line: query.line,
      lineText,
      sessions,
      gitEvidence: evidence
    });
    return sessions[0]
      ? { ...explanation, sessionProvider: sessions[0].provider }
      : explanation;
  });

  app.get("/api/v1/repositories/:id/sessions", {
    schema: { params: IdParams }
  }, async (request) => {
    const record = await repository(request, registry);
    const safe = await new ProvenanceStore(record.root).sessions();
    return {
      sessions: safe.map(sessionSummary)
    };
  });

  app.get("/api/v1/repositories/:id/sessions/:provider/:sessionId", {
    schema: { params: SessionParams }
  }, async (request, reply) => {
    const record = await repository(request, registry);
    const params = request.params as { provider: string; sessionId: string };
    const store = new ProvenanceStore(record.root);
    const stored = await store.sessions();
    const candidate = stored.find(
      (session) =>
        session.provider === params.provider &&
        session.sessionId === params.sessionId
    );
    if (!candidate) return reply.code(404).send({ error: "not_found", message: "Session not found." });
    const session = (await safeSessions(
      [candidate],
      record.root,
      config.transcriptRoots
    ))[0]!;
    const eventPage = await store.boundedEvents(MAX_GRAPH_EVENTS);
    return {
      session,
      evidence: await loadSessionEvidence(session),
      graph: await buildProvenanceGraph(
        record.root,
        stored,
        eventPage.events,
        undefined,
        eventPage.truncated ? ["events"] : []
      )
    };
  });

  app.get("/api/v1/repositories/:id/export", {
    schema: {
      params: IdParams,
      querystring: ExportQuerySchema
    }
  }, async (request, reply) => {
    const record = await repository(request, registry);
    const query = request.query as ExportQuery;
    const store = new ProvenanceStore(record.root);
    const stored = await store.sessions();
    if (query.kind === "agent-trace") {
      const all = await safeSessions(
        stored.slice(0, MAX_GRAPH_SESSIONS),
        record.root,
        config.transcriptRoots
      );
      return download(reply, `${safeName(record.name)}-agent-trace.jsonl`, "application/x-ndjson",
        agentTraceJsonl(await agentTraceRecords(record.root, all)));
    }
    if (query.kind === "session-markdown" || query.kind === "session-json") {
      if (!query.provider || !query.session) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "Provider and session are required."
        });
      }
      const candidate = stored.find(
        (session) =>
          session.provider === query.provider &&
          session.sessionId === query.session
      );
      if (!candidate) return reply.code(404).send({ error: "not_found", message: "Session not found." });
      const session = (await safeSessions(
        [candidate],
        record.root,
        config.transcriptRoots
      ))[0]!;
      const evidence = await loadSessionEvidence(session);
      const markdown = query.kind === "session-markdown";
      return download(
        reply,
        `${safeName(session.provider)}-${safeName(session.sessionId)}.${markdown ? "md" : "json"}`,
        markdown ? "text/markdown; charset=utf-8" : "application/json",
        markdown ? sessionEvidenceMarkdown(evidence) : sessionEvidenceJson(evidence)
      );
    }
    if (!query.path || !query.line) {
      return reply.code(400).send({ error: "invalid_request", message: "Path and line are required." });
    }
    const material = await resolveLineMaterial(git, record.root, {
      path: query.path,
      line: query.line,
      ...(query.base ? { base: query.base } : {}),
      ...(query.side ? { side: query.side } : {}),
      ...(query.previousPath ? { previousPath: query.previousPath } : {})
    });
    const lineText = material.source.split(/\r?\n/)[query.line - 1] ?? "";
    const evidence = parseBlame(material.blame, query.line, lineText);
    const matching = await store.matchingSessions(material.path, query.line, evidence.commitSha);
    return download(
      reply,
      `${safeName(material.path)}-${query.line}-explanation.md`,
      "text/markdown; charset=utf-8",
      explanationMarkdown(explainLine({
        file: material.path,
        line: query.line,
        lineText,
        sessions: matching,
        gitEvidence: evidence
      }))
    );
  });

  app.post("/api/v1/demo/reset", async () => {
    const root = await resetDemoRepository(config.stateDirectory, git);
    const record = await registry.add(root);
    return { repository: record, reset: true };
  });

  app.get("/api/v1/capture/status", async () => capture.health());

  app.get("/api/v1/repositories/:id/capture", {
    schema: {
      params: IdParams,
      response: { 200: RepositoryCaptureResponseSchema }
    }
  }, async (request): Promise<RepositoryCaptureResponse> => {
    const record = await repository(request, registry);
    return {
      harnesses: await Promise.all([
        harnessStatus(record.root, "codex"),
        harnessStatus(record.root, "github-copilot")
      ]),
      health: await capture.health()
    };
  });

  app.post("/api/v1/repositories/:id/capture/install", {
    schema: {
      params: IdParams,
      body: Type.Object({
        provider: Type.Union([
          Type.Literal("codex"),
          Type.Literal("github-copilot")
        ])
      })
    }
  }, async (request) => {
    const record = await repository(request, registry);
    const provider = (request.body as { provider: HarnessProvider }).provider;
    const source = process.env["LINEAGE_CAPTURE_EXECUTABLE"] ??
      join(process.cwd(), "dist", "lineage-capture.mjs");
    const executable = await installCaptureExecutable(source, config.stateDirectory);
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(executable)}`;
    const clientPath = join(config.stateDirectory, "capture-client.json");
    const previousClient = await readFile(clientPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const rotation = await credentials.beginCaptureRotation();
    try {
      await writeCaptureClientConfig(config.stateDirectory, {
        version: 1,
        endpoint: `http://${config.captureHost}:${config.capturePort}/api/v1/capture`,
        token: rotation.token,
        outboxDirectory: join(config.stateDirectory, "capture-outbox"),
        baselineDirectory: join(config.stateDirectory, "capture-baselines")
      });
      const installed = await installHarness(record.root, provider, command);
      const health = await capture.health();
      await credentials.commitCaptureRotation(rotation.id);
      await credentials.finalizeCaptureRotation(rotation.id);
      return {
        installed,
        health
      };
    } catch (error) {
      if (previousClient) {
        await atomicWrite(clientPath, previousClient, 0o600);
      } else {
        await rm(clientPath, { force: true });
      }
      await credentials.cancelCaptureRotation(rotation.id);
      throw error;
    }
  });

  app.post("/api/v1/capture/replay", async () => ({
    ...(await capture.replay()),
    health: await capture.health()
  }));

  app.post("/api/v1/capture/deadletters", {
    schema: {
      body: Type.Object({
        action: Type.Union([Type.Literal("retry"), Type.Literal("discard")])
      })
    }
  }, async (request) => {
    const body = request.body as { action: "retry" | "discard" };
    const affected =
      body.action === "retry"
        ? await capture.outbox.retryDeadLetters()
        : await capture.outbox.discardDeadLetters();
    if (body.action === "retry") await capture.replay();
    return { action: body.action, affected, health: await capture.health() };
  });

  app.post("/api/v1/capture/incomplete/acknowledge", async () => {
    await capture.clearIncompleteEvidence();
    return { acknowledged: true, health: await capture.health() };
  });

  app.post("/api/v1/repositories/:id/follow-up", {
    schema: {
      params: IdParams,
      body: FollowUpRequestSchema
    }
  }, async (request) => {
    const record = await repository(request, registry);
    const body = request.body as FollowUpRequest;
    const material = await resolveLineMaterial(git, record.root, body);
    const lineText = material.source.split(/\r?\n/)[body.line - 1] ?? "";
    const gitEvidence = parseBlame(material.blame, body.line, lineText);
    const matching = await new ProvenanceStore(record.root).matchingSessions(
      material.path,
      body.line,
      gitEvidence.commitSha
    );
    const explanation = explainLine({
      file: material.path,
      line: body.line,
      lineText,
      sessions: matching,
      gitEvidence
    });
    return { answer: answerFollowUp(body.question, explanation) };
  });

  app.post("/api/v1/repositories/:id/capture/recover-codex", {
    schema: { params: IdParams }
  }, async (request) => {
    const record = await repository(request, registry);
    return recoverCodexTranscripts(record.root, config.transcriptRoots);
  });

  try {
    const webRoot = await realpath(
      process.env["LINEAGE_WEB_ROOT"] ?? join(process.cwd(), "dist", "web")
    );
    await app.register(fastifyStatic, {
      root: webRoot,
      index: ["index.html"]
    });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === "GET" &&
        !request.url.startsWith("/api/")
      ) {
        return reply.header("cache-control", "no-store").sendFile("index.html");
      }
      return reply.code(404).send({ error: "not_found", message: "Route not found." });
    });
  } catch (error) {
    if (process.env["NODE_ENV"] === "production") throw error;
    // Development and integration tests may run before the web build exists.
  }

  return {
    app,
    captureApp,
    bootstrap,
    services: { credentials, sessions, registry, git, capture }
  };
}

async function repository(
  request: FastifyRequest,
  registry: RepositoryRegistry
) {
  return registry.resolve((request.params as { id: string }).id);
}

function sessionSummary(session: ProvenanceSession) {
  return {
    provider: session.provider,
    providerDisplayName: session.providerDisplayName,
    sessionId: session.sessionId,
    prompt: session.prompt,
    filesEdited: session.filesEdited,
    testsResult: session.testsResult,
    commitSha: session.commitSha ?? null,
    lineRanges: session.lineRanges
  };
}

function download(
  reply: FastifyReply,
  filename: string,
  type: string,
  body: string
) {
  return reply
    .header("content-disposition", `attachment; filename="${filename}"`)
    .type(type)
    .send(body);
}

async function safeSessions(
  sessions: ProvenanceSession[],
  repoRoot: string,
  configuredRoots: string[]
): Promise<ProvenanceSession[]> {
  const roots: string[] = [];
  for (const root of [repoRoot, ...configuredRoots]) {
    try {
      roots.push(await realpath(root));
    } catch {
      // An unavailable transcript root grants no access.
    }
  }
  return Promise.all(
    sessions.map(async (session) => {
      if (!session.transcriptPath) return session;
      try {
        const transcript = await realpath(session.transcriptPath);
        if (roots.some((root) => withinPath(root, transcript))) {
          const validated = await validateCodexTranscriptIdentity(
            transcript,
            repoRoot,
            session
          );
          if (validated) return { ...session, transcriptPath: validated };
        }
      } catch {
        // Missing or unsafe transcript evidence is represented as unavailable.
      }
      const safe = { ...session };
      delete safe.transcriptPath;
      return safe;
    })
  );
}
