import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InjectOptions } from "light-my-request";
import { buildApp, type BuiltApp } from "../../../src/server/app.js";
import type { ServerConfig } from "../../../src/server/config.js";
import { GitService } from "../../../src/server/git/git-service.js";
import { ProvenanceStore } from "../../../src/domain/provenance-store.js";
import type { ProvenanceSession } from "../../../src/domain/models.js";

const temporaryRoots: string[] = [];
process.env["LINEAGE_LOG_LEVEL"] = "silent";

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function temporaryConfig(): Promise<{
  root: string;
  allowed: string;
  state: string;
  config: ServerConfig;
}> {
  const root = await mkdtemp(join(tmpdir(), "lineage-server-"));
  temporaryRoots.push(root);
  const allowed = join(root, "repositories");
  const state = join(root, "state");
  await mkdir(allowed, { recursive: true });
  return {
    root,
    allowed,
    state,
    config: {
      host: "127.0.0.1",
      port: 3217,
      captureHost: "127.0.0.1",
      capturePort: 3218,
      stateDirectory: state,
      allowedRoots: [allowed],
      transcriptRoots: [],
      allowedHosts: ["localhost", "127.0.0.1"],
      allowedOrigins: ["http://localhost:3217"],
      sessionTtlMs: 60_000,
      gitTimeoutMs: 10_000,
      gitMaxBytes: 4 * 1024 * 1024
    }
  };
}

async function makeRepository(parent: string, name = "project"): Promise<string> {
  const root = join(parent, name);
  await mkdir(join(root, "src"), { recursive: true });
  const git = new GitService();
  await git.run(root, ["init", "-b", "main"]);
  await git.run(root, ["config", "user.name", "Test User"]);
  await git.run(root, ["config", "user.email", "test@example.com"]);
  await writeFile(join(root, "src/value.ts"), "export const value = 1;\n", "utf8");
  await git.run(root, ["add", "."]);
  await git.run(root, ["commit", "-m", "Initial value"]);
  await git.run(root, ["switch", "-c", "feature/value"]);
  await writeFile(join(root, "src/value.ts"), "export const value = 2;\n", "utf8");
  await git.run(root, ["add", "."]);
  await git.run(root, ["commit", "-m", "Change value"]);
  return root;
}

async function makeDeletedRepository(parent: string): Promise<string> {
  const root = join(parent, "deleted-project");
  await mkdir(join(root, "src"), { recursive: true });
  const git = new GitService();
  await git.run(root, ["init", "-b", "main"]);
  await git.run(root, ["config", "user.name", "Test User"]);
  await git.run(root, ["config", "user.email", "test@example.com"]);
  await writeFile(join(root, "src/removed.ts"), "export const removed = 1;\n", "utf8");
  await git.run(root, ["add", "."]);
  await git.run(root, ["commit", "-m", "Add removable value"]);
  await git.run(root, ["switch", "-c", "feature/remove"]);
  await git.run(root, ["rm", "src/removed.ts"]);
  await git.run(root, ["commit", "-m", "Remove obsolete value"]);
  return root;
}

function session(
  provider: "codex" | "github-copilot",
  providerDisplayName: string,
  prompt: string
): ProvenanceSession {
  return {
    provider,
    providerDisplayName,
    sessionId: "shared-session",
    source: provider,
    actor: providerDisplayName,
    humanReviewer: "operator",
    prompt,
    toolsUsed: [],
    commandsRun: [],
    filesEdited: ["src/value.ts"],
    testsRun: [],
    testsResult: "unknown",
    permissionRequests: [],
    decisions: [],
    externalConstraints: [],
    lastAssistantMessage: "",
    gitDiff: "",
    reasoningSummary: "",
    lineRanges: []
  };
}

async function authenticate(built: BuiltApp, token = built.bootstrap.operatorToken!) {
  const response = await built.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { host: "localhost" },
    payload: { token }
  });
  expect(response.statusCode).toBe(200);
  const cookie = String(response.headers["set-cookie"]).split(";")[0]!;
  const body = response.json<{ csrf: string }>();
  return { cookie, csrf: body.csrf };
}

function authenticated(
  auth: { cookie: string; csrf: string },
  method: "GET" | "POST" | "DELETE",
  url: string,
  payload?: Record<string, unknown>
): InjectOptions {
  return {
    method,
    url,
    headers: {
      host: "localhost",
      cookie: auth.cookie,
      ...(method === "GET" ? {} : { "x-csrf-token": auth.csrf })
    },
    ...(payload === undefined ? {} : { payload })
  };
}

describe("self-hosted server", () => {
  it("persists verifier-only credentials and remembered repositories across restart", async () => {
    const fixture = await temporaryConfig();
    const repo = await makeRepository(fixture.allowed);
    const first = await buildApp(fixture.config);
    const token = first.bootstrap.operatorToken!;
    expect(token).toBeTruthy();
    expect(first.bootstrap.captureToken).toBeTruthy();
    const auth = await authenticate(first);
    const add = await first.app.inject(
      authenticated(auth, "POST", "/api/v1/repositories", { path: repo })
    );
    expect(add.statusCode).toBe(201);
    const repository = add.json<{ repository: { id: string; root: string } }>().repository;
    expect(repository.root).toBe(repo);

    const credentials = JSON.parse(
      await readFile(join(fixture.state, "credentials.json"), "utf8")
    ) as Record<string, unknown>;
    expect(JSON.stringify(credentials)).not.toContain(token);
    expect((await stat(fixture.state)).mode & 0o777).toBe(0o700);
    expect((await stat(join(fixture.state, "credentials.json"))).mode & 0o777).toBe(0o600);
    await first.app.close();

    const second = await buildApp(fixture.config);
    expect(second.bootstrap).toEqual({});
    const secondAuth = await authenticate(second, token);
    const list = await second.app.inject(
      authenticated(secondAuth, "GET", "/api/v1/repositories")
    );
    expect(list.statusCode).toBe(200);
    expect(list.json<{ repositories: Array<{ id: string; available: boolean }> }>().repositories)
      .toEqual([expect.objectContaining({ id: repository.id, available: true })]);
    await second.app.close();
  });

  it("serves Review, Explore, explanations, branch changes, and exports from real Git", async () => {
    const fixture = await temporaryConfig();
    const repo = await makeRepository(fixture.allowed);
    const built = await buildApp(fixture.config);
    const auth = await authenticate(built);
    const add = await built.app.inject(
      authenticated(auth, "POST", "/api/v1/repositories", { path: repo })
    );
    const id = add.json<{ repository: { id: string } }>().repository.id;

    const details = await built.app.inject(
      authenticated(auth, "GET", `/api/v1/repositories/${id}`)
    );
    expect(details.json()).toMatchObject({
      currentBranch: "feature/value",
      defaultBase: "main"
    });

    const review = await built.app.inject(
      authenticated(auth, "GET", `/api/v1/repositories/${id}/review?base=main`)
    );
    expect(review.statusCode).toBe(200);
    expect(review.json()).toMatchObject({
      mergeBase: expect.stringMatching(/^[0-9a-f]{40}$/),
      commits: [
        expect.objectContaining({
          subject: "Change value"
        })
      ],
      metrics: {
        commits: 1,
        files: 1,
        additions: 1,
        deletions: 1
      },
      files: [{ path: "src/value.ts", status: "modified" }]
    });

    const diff = await built.app.inject(
      authenticated(
        auth,
        "GET",
        `/api/v1/repositories/${id}/diff?base=main&path=src%2Fvalue.ts`
      )
    );
    expect(diff.statusCode).toBe(200);
    expect(diff.json<{ hunks: Array<{ lines: Array<{ newLine?: number }> }> }>().hunks[0]?.lines)
      .toEqual(expect.arrayContaining([expect.objectContaining({ newLine: 1 })]));

    const source = await built.app.inject(
      authenticated(
        auth,
        "GET",
        `/api/v1/repositories/${id}/source?path=src%2Fvalue.ts`
      )
    );
    expect(source.json()).toMatchObject({ path: "src/value.ts" });
    expect(source.json<{ lines: Array<{ number: number; text: string }> }>().lines)
      .toEqual(expect.arrayContaining([
        { number: 1, text: "export const value = 2;" }
      ]));

    const explanation = await built.app.inject(
      authenticated(
        auth,
        "GET",
        `/api/v1/repositories/${id}/explain?path=src%2Fvalue.ts&line=1`
      )
    );
    expect(explanation.statusCode).toBe(200);
    expect(explanation.json<{ answer: string }>().answer).toContain("Git history only");

    const exported = await built.app.inject(
      authenticated(auth, "GET", `/api/v1/repositories/${id}/export?kind=agent-trace`)
    );
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-disposition"]).toContain("attachment");

    const switched = await built.app.inject(
      authenticated(auth, "POST", `/api/v1/repositories/${id}/branch`, {
        branch: "main"
      })
    );
    expect(switched.json()).toEqual({ currentBranch: "main" });
    await built.app.close();
  });

  it("resolves deleted old-side evidence against the merge-base", async () => {
    const fixture = await temporaryConfig();
    const repo = await makeDeletedRepository(fixture.allowed);
    const built = await buildApp(fixture.config);
    const auth = await authenticate(built);
    const add = await built.app.inject(
      authenticated(auth, "POST", "/api/v1/repositories", { path: repo })
    );
    const id = add.json<{ repository: { id: string } }>().repository.id;
    const selection =
      "base=main&side=old&path=src%2Fremoved.ts&line=1";

    const explanation = await built.app.inject(
      authenticated(
        auth,
        "GET",
        `/api/v1/repositories/${id}/explain?${selection}`
      )
    );
    expect(explanation.statusCode).toBe(200);
    expect(explanation.json()).toMatchObject({
      file: "src/removed.ts",
      line: 1,
      gitEvidence: {
        content: "export const removed = 1;",
        commitSummary: "Add removable value"
      }
    });

    const followUp = await built.app.inject(
      authenticated(auth, "POST", `/api/v1/repositories/${id}/follow-up`, {
        path: "src/removed.ts",
        line: 1,
        base: "main",
        side: "old",
        question: "What evidence supports this?"
      })
    );
    expect(followUp.statusCode).toBe(200);
    expect(followUp.json<{ answer: string }>().answer).toContain("Git evidence");

    const exported = await built.app.inject(
      authenticated(
        auth,
        "GET",
        `/api/v1/repositories/${id}/export?kind=explanation&${selection}`
      )
    );
    expect(exported.statusCode).toBe(200);
    expect(exported.body).toContain("src/removed.ts:1");
    await built.app.close();
  });

  it("addresses colliding session IDs by provider for detail and export", async () => {
    const fixture = await temporaryConfig();
    const repo = await makeRepository(fixture.allowed);
    const store = new ProvenanceStore(repo);
    await store.writeSession(session("codex", "Codex", "Codex prompt"));
    await store.writeSession(
      session("github-copilot", "GitHub Copilot CLI", "Copilot prompt")
    );
    const built = await buildApp(fixture.config);
    const auth = await authenticate(built);
    const add = await built.app.inject(
      authenticated(auth, "POST", "/api/v1/repositories", { path: repo })
    );
    const id = add.json<{ repository: { id: string } }>().repository.id;

    const codex = await built.app.inject(
      authenticated(
        auth,
        "GET",
        `/api/v1/repositories/${id}/sessions/codex/shared-session`
      )
    );
    const copilot = await built.app.inject(
      authenticated(
        auth,
        "GET",
        `/api/v1/repositories/${id}/sessions/github-copilot/shared-session`
      )
    );
    expect(codex.json()).toMatchObject({
      session: { provider: "codex", prompt: "Codex prompt" }
    });
    expect(copilot.json()).toMatchObject({
      session: { provider: "github-copilot", prompt: "Copilot prompt" }
    });

    const codexExport = await built.app.inject(
      authenticated(
        auth,
        "GET",
        `/api/v1/repositories/${id}/export?kind=session-json&provider=codex&session=shared-session`
      )
    );
    const copilotExport = await built.app.inject(
      authenticated(
        auth,
        "GET",
        `/api/v1/repositories/${id}/export?kind=session-json&provider=github-copilot&session=shared-session`
      )
    );
    expect(JSON.parse(codexExport.body)).toMatchObject({
      provider: "Codex",
      prompt: "Codex prompt"
    });
    expect(JSON.parse(copilotExport.body)).toMatchObject({
      provider: "GitHub Copilot CLI",
      prompt: "Copilot prompt"
    });
    await built.app.close();
  });

  it("returns the shared capture harness status contract", async () => {
    const fixture = await temporaryConfig();
    const repo = await makeRepository(fixture.allowed);
    await mkdir(join(repo, ".codex"), { recursive: true });
    await writeFile(
      join(repo, ".codex/config.toml"),
      "[features]\nother = true\n",
      "utf8"
    );
    const built = await buildApp(fixture.config);
    const auth = await authenticate(built);
    const add = await built.app.inject(
      authenticated(auth, "POST", "/api/v1/repositories", { path: repo })
    );
    const id = add.json<{ repository: { id: string } }>().repository.id;

    const response = await built.app.inject(
      authenticated(auth, "GET", `/api/v1/repositories/${id}/capture`)
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      harnesses: [
        {
          provider: "codex",
          configured: true,
          owned: false,
          path: join(repo, ".codex/config.toml")
        },
        {
          provider: "github-copilot",
          configured: false,
          owned: false,
          path: join(repo, ".github/hooks/lineage-copilot.json")
        }
      ]
    });
    await built.app.close();
  });

  it("forgets only registry state, re-adds existing provenance, and creates a real demo", async () => {
    const fixture = await temporaryConfig();
    const repo = await makeRepository(fixture.allowed);
    await mkdir(join(repo, ".lineage/provenance"), { recursive: true });
    await writeFile(join(repo, ".lineage/provenance/sentinel"), "keep", "utf8");
    const built = await buildApp(fixture.config);
    const auth = await authenticate(built);
    const add = await built.app.inject(
      authenticated(auth, "POST", "/api/v1/repositories", { path: repo })
    );
    const id = add.json<{ repository: { id: string } }>().repository.id;
    const removed = await built.app.inject(
      authenticated(auth, "DELETE", `/api/v1/repositories/${id}`)
    );
    expect(removed.json()).toEqual({ removed: true, repositoryDataDeleted: false });
    expect(await readFile(join(repo, ".lineage/provenance/sentinel"), "utf8")).toBe("keep");

    const restored = await built.app.inject(
      authenticated(auth, "POST", "/api/v1/repositories", { path: repo })
    );
    expect(restored.statusCode).toBe(201);

    const demo = await built.app.inject(
      authenticated(auth, "POST", "/api/v1/demo/reset")
    );
    expect(demo.statusCode).toBe(200);
    const demoRecord = demo.json<{ repository: { id: string; root: string } }>().repository;
    expect(demoRecord.root).toContain(join(fixture.state, "demos", "lineage-demo"));
    const demoDetails = await built.app.inject(
      authenticated(auth, "GET", `/api/v1/repositories/${demoRecord.id}`)
    );
    expect(demoDetails.json()).toMatchObject({
      currentBranch: "review/retry-policy",
      defaultBase: "main"
    });
    await built.app.close();
  });

  it("rejects outside roots, symlink escapes, bad Host/Origin, missing CSRF, and old tokens", async () => {
    const fixture = await temporaryConfig();
    const outside = await makeRepository(fixture.root, "outside");
    const link = join(fixture.allowed, "escape");
    await symlink(outside, link);
    const built = await buildApp(fixture.config);
    const token = built.bootstrap.operatorToken!;
    const auth = await authenticate(built);

    const outsideResponse = await built.app.inject(
      authenticated(auth, "POST", "/api/v1/repositories", { path: outside })
    );
    expect(outsideResponse.statusCode).toBe(400);
    const symlinkResponse = await built.app.inject(
      authenticated(auth, "POST", "/api/v1/repositories", { path: link })
    );
    expect(symlinkResponse.statusCode).toBe(400);

    expect(
      (
        await built.app.inject({
          method: "GET",
          url: "/api/v1/health",
          headers: { host: "attacker.example" }
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await built.app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          headers: { host: "localhost", origin: "https://attacker.example" },
          payload: { token }
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await built.app.inject({
          method: "POST",
          url: "/api/v1/repositories",
          headers: { host: "localhost", cookie: auth.cookie },
          payload: { path: outside }
        })
      ).statusCode
    ).toBe(403);

    const rotate = await built.app.inject(
      authenticated(auth, "POST", "/api/v1/auth/rotate", { credential: "operator" })
    );
    expect(rotate.statusCode).toBe(200);
    const newToken = rotate.json<{ token: string }>().token;
    expect(newToken).not.toBe(token);
    expect((await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { host: "localhost" },
      payload: { token }
    })).statusCode).toBe(401);
    expect((await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { host: "localhost" },
      payload: { token: newToken }
    })).statusCode).toBe(200);
    await built.app.close();
  });

  it("rejects a stored session transcript belonging to another repository", async () => {
    const fixture = await temporaryConfig();
    const repo = await makeRepository(fixture.allowed, "selected");
    const otherRepo = await makeRepository(fixture.allowed, "other");
    const transcriptRoot = join(fixture.root, "transcripts");
    await mkdir(transcriptRoot, { recursive: true });
    fixture.config.transcriptRoots = [transcriptRoot];
    const transcript = join(transcriptRoot, "foreign.jsonl");
    await writeFile(
      transcript,
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "forged-session", cwd: otherRepo }
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            id: "foreign-message",
            type: "agent_message",
            message: "cross-repository-secret"
          }
        }),
        ""
      ].join("\n"),
      "utf8"
    );
    const session: ProvenanceSession = {
      provider: "codex",
      providerDisplayName: "Codex",
      sessionId: "forged-session",
      source: "stored",
      actor: "Codex",
      transcriptPath: transcript,
      humanReviewer: "Unknown",
      prompt: "",
      toolsUsed: [],
      commandsRun: [],
      filesEdited: [],
      testsRun: [],
      testsResult: "unknown",
      permissionRequests: [],
      decisions: [],
      externalConstraints: [],
      lastAssistantMessage: "",
      gitDiff: "",
      reasoningSummary: "",
      lineRanges: []
    };
    await new ProvenanceStore(repo).writeSession(session);
    const built = await buildApp(fixture.config);
    const auth = await authenticate(built);
    const add = await built.app.inject(
      authenticated(auth, "POST", "/api/v1/repositories", { path: repo })
    );
    const id = add.json<{ repository: { id: string } }>().repository.id;

    const response = await built.app.inject(
      authenticated(
        auth,
        "GET",
        `/api/v1/repositories/${id}/sessions/codex/forged-session`
      )
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      evidence: { transcriptAvailable: false, messages: [] }
    });
    expect(response.body).not.toContain("cross-repository-secret");
    await built.app.close();
  });

  it("throttles repeated login failures, expires sessions, bounds bodies, and emits browser defenses", async () => {
    const fixture = await temporaryConfig();
    fixture.config.sessionTtlMs = 2;
    const built = await buildApp(fixture.config);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rejected = await built.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { host: "localhost" },
        payload: { token: `invalid-token-${"x".repeat(30)}-${attempt}` }
      });
      expect(rejected.statusCode).toBe(401);
    }
    const throttled = await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { host: "localhost" },
      payload: { token: built.bootstrap.operatorToken }
    });
    expect(throttled.statusCode).toBe(429);

    const second = await buildApp({
      ...fixture.config,
      stateDirectory: join(fixture.root, "second-state")
    });
    const auth = await authenticate(second);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const expired = await second.app.inject(
      authenticated(auth, "GET", "/api/v1/repositories")
    );
    expect(expired.statusCode).toBe(401);

    const health = await second.app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { host: "localhost" }
    });
    expect(health.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(health.headers["x-content-type-options"]).toBe("nosniff");
    expect(health.headers["x-frame-options"]).toBe("DENY");
    const oversized = await second.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { host: "localhost", "content-type": "application/json" },
      payload: { token: "x".repeat(1024 * 1024 + 1) }
    });
    expect(oversized.statusCode).toBe(413);
    await built.app.close();
    await second.app.close();
  });
});
