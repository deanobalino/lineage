import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitService } from "../../../src/server/git/git-service.js";
import { reviewMetrics } from "../../../src/server/git/review.js";
import { linkRepository } from "../../../src/domain/linker.js";
import type { LineageEvent } from "../../../src/domain/models.js";
import { ProvenanceStore } from "../../../src/domain/provenance-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function repository(): Promise<{ root: string; git: GitService }> {
  const root = await mkdtemp(join(tmpdir(), "lineage-git-"));
  roots.push(root);
  const git = new GitService();
  await git.run(root, ["init", "-b", "main"]);
  await git.run(root, ["config", "user.name", "Test User"]);
  await git.run(root, ["config", "user.email", "test@example.com"]);
  await writeFile(
    join(root, "before.txt"),
    Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n") + "\n"
  );
  await git.run(root, ["add", "."]);
  await git.run(root, ["commit", "-m", "Initial"]);
  return { root, git };
}

describe("Git review semantics", () => {
  it("uses the current branch as the empty comparison fallback", async () => {
    const { root, git } = await repository();
    const branches = await git.branches(root);
    expect(git.defaultBase(branches, "main")).toBe("main");
  });

  it("creates a local tracking branch from a remote ref", async () => {
    const { root, git } = await repository();
    await git.run(root, ["switch", "-c", "feature/remote"]);
    await writeFile(join(root, "remote.txt"), "remote branch\n");
    await git.run(root, ["add", "."]);
    await git.run(root, ["commit", "-m", "Remote branch"]);
    const remoteSha = (await git.run(root, ["rev-parse", "HEAD"])).stdout.trim();
    await git.run(root, ["switch", "main"]);
    await git.run(root, ["branch", "-D", "feature/remote"]);
    await git.run(root, ["config", "remote.origin.url", root]);
    await git.run(root, [
      "config",
      "remote.origin.fetch",
      "+refs/heads/*:refs/remotes/origin/*"
    ]);
    await git.run(root, [
      "update-ref",
      "refs/remotes/origin/feature/remote",
      remoteSha
    ]);

    await git.switchBranch(root, "origin/feature/remote");
    expect(await git.currentBranch(root)).toBe("feature/remote");
    expect(
      (await git.branches(root)).find(
        (branch) => !branch.remote && branch.name === "feature/remote"
      )?.upstream
    ).toBe("origin/feature/remote");
  });

  it("reads blame from the base revision after a line is deleted", async () => {
    const { root, git } = await repository();
    await git.run(root, ["switch", "-c", "feature/delete"]);
    await writeFile(join(root, "before.txt"), "replacement\n");
    await git.run(root, ["add", "."]);
    await git.run(root, ["commit", "-m", "Delete old lines"]);

    const blame = await git.blame(root, "before.txt", 2, "main");
    expect(blame).toContain("\nauthor Test User\n");
    expect(blame).toContain("\tline 2");
  });

  it("attributes edited rename churn and counts feature-only commits", async () => {
    const { root, git } = await repository();
    await git.run(root, ["switch", "-c", "feature/rename"]);
    await git.run(root, ["mv", "before.txt", "after.txt"]);
    await writeFile(
      join(root, "after.txt"),
      Array.from({ length: 21 }, (_, index) => `line ${index + 1}`).join("\n") + "\n"
    );
    await git.run(root, ["add", "."]);
    await git.run(root, ["commit", "-m", "Rename and extend"]);

    await git.run(root, ["switch", "main"]);
    await writeFile(join(root, "base.txt"), "base one\n");
    await git.run(root, ["add", "."]);
    await git.run(root, ["commit", "-m", "Base one"]);
    await writeFile(join(root, "base.txt"), "base one\nbase two\n");
    await git.run(root, ["add", "."]);
    await git.run(root, ["commit", "-m", "Base two"]);
    await git.run(root, ["switch", "feature/rename"]);

    const files = await git.changedFiles(root, "main");
    expect(files).toEqual([
      expect.objectContaining({
        path: "after.txt",
        previousPath: "before.txt",
        status: "renamed",
        additions: 1,
        deletions: 0
      })
    ]);
    expect((await reviewMetrics(git, root, "main", files, [])).commits).toBe(1);
  });

  it("retains the subject of a commit created during a captured session", async () => {
    const { root, git } = await repository();
    const before = (await git.run(root, ["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(root, "before.txt"), "captured change\n");
    await git.run(root, ["add", "."]);
    await git.run(root, ["commit", "-m", "Captured change"]);
    const after = (await git.run(root, ["rev-parse", "HEAD"])).stdout.trim();
    const base: LineageEvent = {
      id: "start",
      lineageSchemaVersion: "0.1",
      capturedAt: "2026-07-28T12:00:00.000Z",
      source: "provider-hook",
      provider: "codex",
      providerEventName: "SessionStart",
      eventType: "session_start",
      actor: "Codex",
      hookEventName: "SessionStart",
      sessionId: "commit-message",
      repoRoot: root,
      payload: { git_head: before }
    };
    const store = new ProvenanceStore(root);
    await store.append(base);
    await store.append({
      ...base,
      id: "stop",
      capturedAt: "2026-07-28T12:01:00.000Z",
      providerEventName: "Stop",
      eventType: "session_stop",
      hookEventName: "Stop",
      payload: {
        git_head: after,
        changed_files: ["before.txt"],
        git_diff:
          "diff --git a/before.txt b/before.txt\n--- a/before.txt\n+++ b/before.txt\n@@ -1 +1 @@\n-before\n+captured change"
      }
    });

    expect((await linkRepository(store))[0]?.commitMessage).toBe(
      "Captured change"
    );
  });
});
