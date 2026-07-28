import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalEvent, linkRepository, ProvenanceStore } from "../../domain/index.js";
import type { GitService } from "../git/git-service.js";

export async function resetDemoRepository(
  stateDirectory: string,
  git: GitService
): Promise<string> {
  const demosRoot = resolve(stateDirectory, "demos");
  const root = resolve(demosRoot, "lineage-demo");
  if (!root.startsWith(`${demosRoot}/`)) throw new Error("Invalid demo path.");
  await rm(root, { force: true, recursive: true });
  await mkdir(join(root, "src"), { recursive: true, mode: 0o700 });
  await git.run(root, ["init", "-b", "main"]);
  await git.run(root, ["config", "user.name", "Lineage Demo"]);
  await git.run(root, ["config", "user.email", "demo@lineage.local"]);
  await writeFile(
    join(root, "src/retry.ts"),
    "export const MAX_RETRIES = 5;\n\nexport function retryDelay(attempt: number) {\n  return attempt * 100;\n}\n",
    "utf8"
  );
  await git.run(root, ["add", "src/retry.ts"]);
  await git.run(root, ["commit", "-m", "Add bounded retry policy"]);
  const startHead = (await git.run(root, ["rev-parse", "HEAD"])).stdout.trim();
  await git.run(root, ["switch", "-c", "review/retry-policy"]);
  await writeFile(
    join(root, "src/retry.ts"),
    "export const MAX_RETRIES = 7;\n\nexport function retryDelay(attempt: number) {\n  return Math.min(attempt * 150, 1200);\n}\n",
    "utf8"
  );
  await git.run(root, ["add", "src/retry.ts"]);
  await git.run(root, ["commit", "-m", "Tune retry ceiling and backoff"]);
  const stopHead = (await git.run(root, ["rev-parse", "HEAD"])).stdout.trim();

  const store = new ProvenanceStore(root);
  const start = canonicalEvent({
    provider: "codex",
    ingestionId: "demo-session-start",
    capturedAt: "2026-07-28T08:00:00Z",
    raw: {
      provider_event_name: "SessionStart",
      session_id: "demo-retry-session",
      model: "gpt-5"
    },
    payload: { git_head: startHead },
    cwd: root,
    repoRoot: root
  });
  const prompt = canonicalEvent({
    provider: "codex",
    ingestionId: "demo-prompt",
    capturedAt: "2026-07-28T08:00:01Z",
    raw: {
      provider_event_name: "UserPromptSubmit",
      session_id: "demo-retry-session",
      model: "gpt-5"
    },
    payload: { prompt: "Keep retries bounded while smoothing the backoff." },
    cwd: root,
    repoRoot: root
  });
  const stop = canonicalEvent({
    provider: "codex",
    ingestionId: "demo-stop",
    capturedAt: "2026-07-28T08:00:10Z",
    raw: {
      provider_event_name: "Stop",
      session_id: "demo-retry-session",
      model: "gpt-5"
    },
    payload: {
      last_assistant_message: "Raised the bounded ceiling and capped the backoff.",
      git_head: stopHead,
      changed_files: ["src/retry.ts"],
      git_diff: (
        await git.run(root, ["diff", "main...HEAD", "--", "src/retry.ts"])
      ).stdout,
      tests_detected: ["npm test"],
      tests_result: "passed"
    },
    cwd: root,
    repoRoot: root
  });
  await store.append(start);
  await store.append(prompt);
  await store.append(stop);
  await linkRepository(store);
  return root;
}
