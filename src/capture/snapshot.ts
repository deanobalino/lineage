import { spawnSync } from "node:child_process";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../domain/provenance-store.js";
import { sha256 } from "../domain/stable.js";
import type { CaptureEnvelope, GitSnapshot } from "./envelope.js";

const GIT_TIMEOUT_MS = 90;
const GIT_MAX_BYTES = 512 * 1024;

function git(repoRoot: string, args: string[]): { output: string; complete: boolean; error?: string } {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BYTES,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }
  });
  if (result.error || result.status !== 0) {
    const response: { output: string; complete: boolean; error?: string } = {
      output: String(result.stdout ?? ""),
      complete: false
    };
    response.error =
      result.error?.message || String(result.stderr ?? "").trim() || "Git snapshot failed.";
    return response;
  }
  return { output: String(result.stdout ?? ""), complete: true };
}

function bounded(value: string): { value: string; truncated: boolean } {
  const data = Buffer.from(value);
  if (data.length <= GIT_MAX_BYTES) return { value, truncated: false };
  return {
    value: data.subarray(0, GIT_MAX_BYTES).toString("utf8"),
    truncated: true
  };
}

export function collectGitSnapshot(repoRoot: string): GitSnapshot {
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  const status = git(repoRoot, ["status", "--short"]);
  const diff = git(repoRoot, ["diff", "--no-ext-diff"]);
  const changed = git(repoRoot, ["diff", "--name-only"]);
  const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  const boundedDiff = bounded(diff.output);
  const errors = [head.error, status.error, diff.error, changed.error, untracked.error].filter(
    (value): value is string => Boolean(value)
  );
  const snapshot: GitSnapshot = {
    head: head.output.trim(),
    status: status.output,
    diff: boundedDiff.value,
    changedFiles: [
      ...new Set(
        `${changed.output}\n${untracked.output}`
          .split("\n")
          .filter((path) => path && !path.startsWith(".lineage/"))
      )
    ].sort(),
    complete:
      head.complete &&
      status.complete &&
      diff.complete &&
      changed.complete &&
      untracked.complete &&
      !boundedDiff.truncated,
    truncated: boundedDiff.truncated
  };
  if (errors.length > 0) snapshot.error = errors.join("; ").slice(0, 1_000);
  return snapshot;
}

interface SessionBaseline {
  head: string;
  diff: string;
  changedFiles: string[];
}

export class BaselineStore {
  constructor(readonly root: string) {}

  path(envelope: CaptureEnvelope): string {
    return join(
      this.root,
      `${sha256(`${envelope.repoRoot}|${envelope.provider}|${envelope.sessionId}`)}.json`
    );
  }

  async write(envelope: CaptureEnvelope, snapshot: GitSnapshot): Promise<void> {
    const baseline: SessionBaseline = {
      head: snapshot.head,
      diff: snapshot.diff,
      changedFiles: snapshot.changedFiles
    };
    await atomicWrite(this.path(envelope), `${JSON.stringify(baseline)}\n`, 0o600);
  }

  async read(envelope: CaptureEnvelope): Promise<SessionBaseline | undefined> {
    try {
      return JSON.parse(await readFile(this.path(envelope), "utf8")) as SessionBaseline;
    } catch {
      return undefined;
    }
  }

  async remove(envelope: CaptureEnvelope): Promise<void> {
    await rm(this.path(envelope), { force: true });
  }
}

export async function finalizeGitEvidence(
  envelope: CaptureEnvelope,
  baselines: BaselineStore
): Promise<CaptureEnvelope> {
  if (envelope.eventType !== "session_start" && envelope.eventType !== "session_stop") {
    const finalized = { ...envelope, evidenceComplete: true };
    delete finalized.evidenceIssue;
    return finalized;
  }
  let snapshot = collectGitSnapshot(envelope.repoRoot);
  if (envelope.eventType === "session_start") {
    await baselines.write(envelope, snapshot);
    snapshot = { ...snapshot, diff: "", changedFiles: [] };
  } else {
    const baseline = await baselines.read(envelope);
    if (baseline) {
      if (baseline.head && snapshot.head && baseline.head !== snapshot.head) {
        const committedDiff = git(envelope.repoRoot, [
          "diff",
          "--no-ext-diff",
          `${baseline.head}..${snapshot.head}`
        ]);
        const committedFiles = git(envelope.repoRoot, [
          "diff",
          "--name-only",
          `${baseline.head}..${snapshot.head}`
        ]);
        const value = bounded(committedDiff.output);
        snapshot = {
          ...snapshot,
          diff: value.value,
          changedFiles: committedFiles.output.split("\n").filter(Boolean).sort(),
          complete:
            snapshot.complete &&
            committedDiff.complete &&
            committedFiles.complete &&
            !value.truncated,
          truncated: snapshot.truncated || value.truncated
        };
      } else if (
        baseline.diff === snapshot.diff &&
        new Set(baseline.changedFiles).size === new Set(snapshot.changedFiles).size &&
        baseline.changedFiles.every((file) => snapshot.changedFiles.includes(file))
      ) {
        snapshot = { ...snapshot, diff: "", changedFiles: [] };
      } else if (baseline.changedFiles.length > 0) {
        const previous = new Set(baseline.changedFiles);
        snapshot = {
          ...snapshot,
          diff: "",
          changedFiles: snapshot.changedFiles.filter((file) => !previous.has(file))
        };
      }
      await baselines.remove(envelope);
    }
  }
  const finalized: CaptureEnvelope = {
    ...envelope,
    gitSnapshot: snapshot,
    evidenceComplete: snapshot.complete
  };
  if (snapshot.complete) delete finalized.evidenceIssue;
  else {
    finalized.evidenceIssue =
      snapshot.error ??
      (snapshot.truncated ? "Git evidence exceeded the snapshot limit." : "Git evidence is incomplete.");
  }
  return finalized;
}
