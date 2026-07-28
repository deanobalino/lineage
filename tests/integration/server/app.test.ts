import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InjectOptions } from "light-my-request";
import { buildApp, type BuiltApp } from "../../../src/server/app.js";
import type { ServerConfig } from "../../../src/server/config.js";
import { GitService } from "../../../src/server/git/git-service.js";

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
});
