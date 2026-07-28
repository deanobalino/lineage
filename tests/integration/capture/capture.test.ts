import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeCaptureClientConfig } from "../../../src/capture/client.js";
import { buildApp, type BuiltApp } from "../../../src/server/app.js";
import type { ServerConfig } from "../../../src/server/config.js";
import { GitService } from "../../../src/server/git/git-service.js";

const run = promisify(execFile);
const roots: string[] = [];
const executable = resolve("dist/lineage-capture.mjs");
process.env["LINEAGE_LOG_LEVEL"] = "silent";

beforeAll(async () => {
  await run(process.execPath, ["scripts/build-capture.mjs"], { cwd: resolve(".") });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

afterAll(async () => {
  // dist is ignored and intentionally retained for later build verification.
});

async function fixture(): Promise<{
  root: string;
  repo: string;
  state: string;
  config: ServerConfig;
}> {
  const root = await mkdtemp(join(tmpdir(), "lineage-capture-"));
  roots.push(root);
  const repositories = join(root, "repositories");
  const repo = join(repositories, "project");
  const state = join(root, "state");
  await mkdir(repo, { recursive: true });
  const git = new GitService();
  await git.run(repo, ["init", "-b", "main"]);
  await git.run(repo, ["config", "user.name", "Capture Test"]);
  await git.run(repo, ["config", "user.email", "capture@example.com"]);
  await writeFile(join(repo, "value.txt"), "one\n", "utf8");
  await git.run(repo, ["add", "."]);
  await git.run(repo, ["commit", "-m", "Initial"]);
  return {
    root,
    repo,
    state,
    config: {
      host: "127.0.0.1",
      port: 3217,
      captureHost: "127.0.0.1",
      capturePort: 3218,
      stateDirectory: state,
      allowedRoots: [repositories],
      transcriptRoots: [],
      allowedHosts: ["localhost", "127.0.0.1"],
      allowedOrigins: ["http://localhost:3217"],
      sessionTtlMs: 60_000,
      gitTimeoutMs: 10_000,
      gitMaxBytes: 4 * 1024 * 1024
    }
  };
}

async function startCapture(f: Awaited<ReturnType<typeof fixture>>): Promise<{
  built: BuiltApp;
  endpoint: string;
}> {
  const built = await buildApp(f.config);
  await built.services.registry.add(f.repo);
  await built.captureApp.listen({ host: "127.0.0.1", port: 0 });
  const address = built.captureApp.server.address();
  if (!address || typeof address === "string") throw new Error("Capture listener missing.");
  const endpoint = `http://127.0.0.1:${address.port}/api/v1/capture`;
  await writeCaptureClientConfig(f.state, {
    version: 1,
    endpoint,
    token: built.bootstrap.captureToken!,
    outboxDirectory: join(f.state, "capture-outbox"),
    baselineDirectory: join(f.state, "capture-baselines")
  });
  return { built, endpoint };
}

async function hook(
  f: Awaited<ReturnType<typeof fixture>>,
  input: Record<string, unknown>,
  environment: Record<string, string> = {}
) {
  const started = performance.now();
  const result = await new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [executable], {
      cwd: f.repo,
      env: {
        ...process.env,
        LINEAGE_STATE_DIR: f.state,
        ...environment
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`capture exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
      } else {
        resolvePromise({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        });
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
  return { ...result, elapsed: performance.now() - started };
}

describe("capture subprocess and server", () => {
  it("fails open under one second and leaves a durable record while the server is absent", async () => {
    const f = await fixture();
    const result = await hook(f, {
      provider_event_name: "UserPromptSubmit",
      session_id: "offline",
      payload: { prompt: "Queue this." }
    });
    expect(result.elapsed).toBeLessThan(1_000);
    expect(result.stderr).toContain("queued");
    const pending = join(f.state, "capture-outbox", "pending");
    const names = await import("node:fs/promises").then(({ readdir }) => readdir(pending));
    expect(names).toHaveLength(1);
    const record = JSON.parse(await readFile(join(pending, names[0]!), "utf8")) as {
      evidenceComplete: boolean;
      raw: Record<string, unknown>;
    };
    expect(record.evidenceComplete).toBe(true);
    expect(record.raw).toMatchObject({ session_id: "offline" });

    const boundary = await hook(f, {
      provider_event_name: "SessionStart",
      session_id: "offline-boundary",
      payload: {}
    });
    expect(boundary.elapsed).toBeLessThan(1_000);
  });

  it("ingests idempotently and preserves Codex and Copilot finalization semantics", async () => {
    const f = await fixture();
    const { built } = await startCapture(f);
    const startResult = await hook(f, {
      provider_event_name: "SessionStart",
      session_id: "codex-session",
      payload: {}
    });
    const deadDirectory = join(f.state, "capture-outbox", "deadletters");
    const deadNames = await import("node:fs/promises").then(({ readdir }) =>
      readdir(deadDirectory)
    );
    const errorName = deadNames.find((name) => name.endsWith(".error"));
    const captureError = errorName
      ? await readFile(join(deadDirectory, errorName), "utf8")
      : "";
    expect(startResult.stderr, captureError).toBe("");
    await writeFile(join(f.repo, "value.txt"), "two\n", "utf8");
    await hook(f, {
      provider_event_name: "Stop",
      session_id: "codex-session",
      payload: { last_assistant_message: "Changed value." }
    });
    await hook(
      f,
      { sessionId: "copilot-session", payload: {} },
      { LINEAGE_PROVIDER: "github-copilot", LINEAGE_HOOK_EVENT: "Stop" }
    );
    expect((await new (await import("../../../src/domain/provenance-store.js")).ProvenanceStore(f.repo).sessions())
      .some((session) => session.sessionId === "copilot-session")).toBe(false);
    await hook(
      f,
      { sessionId: "copilot-session", payload: {} },
      { LINEAGE_PROVIDER: "github-copilot", LINEAGE_HOOK_EVENT: "SessionEnd" }
    );

    const store = new (await import("../../../src/domain/provenance-store.js")).ProvenanceStore(f.repo);
    const events = await store.events();
    const sessions = await store.sessions();
    expect(events.filter((event) => event.sessionId === "codex-session")).toHaveLength(2);
    expect(sessions.map((session) => session.sessionId).sort()).toEqual([
      "codex-session",
      "copilot-session"
    ]);
    expect(
      events.find((event) => event.sessionId === "copilot-session" && event.providerEventName === "Stop")
        ?.eventType
    ).toBe("agent_stop");

    const duplicate = events[0]!;
    const envelope = {
      version: 1,
      ingestionId: duplicate.id,
      capturedAt: duplicate.capturedAt,
      provider: duplicate.provider,
      providerEventName: duplicate.providerEventName,
      eventType: duplicate.eventType,
      sessionId: duplicate.sessionId,
      cwd: f.repo,
      repoRoot: f.repo,
      raw: {},
      environment: {},
      evidenceComplete: true
    };
    const response = await built.captureApp.inject({
      method: "POST",
      url: "/api/v1/capture",
      headers: {
        host: "127.0.0.1",
        authorization: `Bearer ${built.bootstrap.captureToken}`
      },
      payload: envelope
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ duplicate: true });
    await built.captureApp.close();
    await built.app.close();
  });

  it("replays queued events, dead-letters unregistered repositories, and reports health", async () => {
    const f = await fixture();
    await hook(f, {
      provider_event_name: "UserPromptSubmit",
      session_id: "queued",
      payload: { prompt: "Replay me." }
    });
    const { built } = await startCapture(f);
    expect(await built.services.capture.replay()).toEqual({
      delivered: 1,
      deadLetters: 0
    });
    expect(await built.services.capture.health()).toMatchObject({
      state: "healthy",
      pending: 0
    });

    const invalid: import("../../../src/capture/envelope.js").CaptureEnvelope = {
      version: 1 as const,
      ingestionId: "unregistered",
      capturedAt: "2026-07-28T00:00:00Z",
      provider: "codex",
      providerEventName: "UserPromptSubmit",
      eventType: "prompt",
      sessionId: "bad",
      cwd: f.root,
      repoRoot: f.root,
      raw: {},
      environment: {},
      evidenceComplete: true
    };
    await built.services.capture.outbox.enqueue(invalid);
    expect(await built.services.capture.replay()).toEqual({
      delivered: 0,
      deadLetters: 1
    });
    expect(await built.services.capture.health()).toMatchObject({
      state: "degraded",
      deadLetters: 1
    });
    await built.captureApp.close();
    await built.app.close();
  });

  it("handles parallel hook processes without corrupting the outbox or events file", async () => {
    const f = await fixture();
    const { built } = await startCapture(f);
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        hook(f, {
          provider_event_name: "UserPromptSubmit",
          session_id: `parallel-${index}`,
          payload: { prompt: `Prompt ${index}` }
        })
      )
    );
    await built.services.capture.replay();
    const store = new (await import("../../../src/domain/provenance-store.js")).ProvenanceStore(f.repo);
    const events = await store.events();
    expect(events.filter((event) => event.sessionId.startsWith("parallel-"))).toHaveLength(8);
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
    await built.captureApp.close();
    await built.app.close();
  });
});
