import { spawn } from "node:child_process";

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitBranch {
  name: string;
  fullName: string;
  sha: string;
  remote: boolean;
  upstream?: string;
}

export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown";
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface BranchCommit {
  sha: string;
  shortSha: string;
  author: string;
  authoredAt: string;
  subject: string;
}

export class GitService {
  constructor(
    readonly timeoutMs = 15_000,
    readonly maxBytes = 16 * 1024 * 1024
  ) {}

  run(repoRoot: string, args: string[], options: { allowFailure?: boolean } = {}): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", ["-C", repoRoot, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          LC_ALL: "C"
        }
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (error?: Error, result?: GitResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result!);
      };
      const collect = (target: Buffer[], chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > this.maxBytes) {
          child.kill("SIGKILL");
          finish(new GitError("Git output exceeded the configured limit.", null, ""));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.on("error", (error) => finish(error));
      child.on("close", (code) => {
        const result: GitResult = {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: code ?? 1
        };
        if (result.exitCode !== 0 && !options.allowFailure) {
          finish(
            new GitError(
              `Git ${args[0] ?? "command"} failed.`,
              result.exitCode,
              result.stderr.trim()
            )
          );
        } else {
          finish(undefined, result);
        }
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new GitError("Git command timed out.", null, ""));
      }, this.timeoutMs);
      timer.unref();
    });
  }

  async root(path: string): Promise<string> {
    return (await this.run(path, ["rev-parse", "--show-toplevel"])).stdout.trim();
  }

  async trackedFiles(repoRoot: string): Promise<string[]> {
    return (await this.run(repoRoot, ["ls-files", "-z"])).stdout
      .split("\0")
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
  }

  async branches(repoRoot: string): Promise<GitBranch[]> {
    const output = (
      await this.run(repoRoot, [
        "for-each-ref",
        "--format=%(refname)%09%(objectname)%09%(upstream:short)",
        "refs/heads",
        "refs/remotes"
      ])
    ).stdout;
    return output
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const [fullName, sha, upstream] = line.split("\t");
        if (!fullName || !sha || fullName.endsWith("/HEAD")) return [];
        const remote = fullName.startsWith("refs/remotes/");
        const name = fullName.replace(remote ? "refs/remotes/" : "refs/heads/", "");
        const branch: GitBranch = { name, fullName, sha, remote };
        if (upstream) branch.upstream = upstream;
        return [branch];
      })
      .sort((left, right) => Number(left.remote) - Number(right.remote) || left.name.localeCompare(right.name));
  }

  async currentBranch(repoRoot: string): Promise<string | undefined> {
    const result = await this.run(repoRoot, ["symbolic-ref", "--short", "HEAD"], {
      allowFailure: true
    });
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  defaultBase(branches: GitBranch[], current?: string): string | undefined {
    const available = new Set(branches.map((branch) => branch.name));
    const currentUpstream = branches.find(
      (branch) => !branch.remote && branch.name === current
    )?.upstream;
    const candidates = [
      "origin/main",
      "main",
      "upstream/main",
      "origin/master",
      "master",
      currentUpstream,
      current
    ].filter((name): name is string => Boolean(name));
    return candidates.find((name) => available.has(name));
  }

  async changedFiles(repoRoot: string, base: string): Promise<ChangedFile[]> {
    await this.requireBranch(repoRoot, base);
    const range = `${base}...HEAD`;
    const names = (
      await this.run(repoRoot, ["diff", "--name-status", "-z", "--find-renames", range])
    ).stdout.split("\0");
    const files: ChangedFile[] = [];
    for (let index = 0; index < names.length; ) {
      const statusCode = names[index++];
      if (!statusCode) break;
      const statusLetter = statusCode[0] ?? "?";
      if (statusLetter === "R" || statusLetter === "C") {
        const previousPath = names[index++];
        const path = names[index++];
        if (!path || !previousPath) continue;
        files.push({
          path,
          previousPath,
          status: statusLetter === "R" ? "renamed" : "copied",
          additions: 0,
          deletions: 0,
          binary: false
        });
      } else {
        const path = names[index++];
        if (!path) continue;
        const statuses: Record<string, ChangedFile["status"]> = {
          A: "added",
          M: "modified",
          D: "deleted"
        };
        files.push({
          path,
          status: statuses[statusLetter] ?? "unknown",
          additions: 0,
          deletions: 0,
          binary: false
        });
      }
    }
    const numstat = (
      await this.run(repoRoot, ["diff", "--numstat", "-z", "--find-renames", range])
    ).stdout.split("\0");
    const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
    for (let index = 0; index < numstat.length; index += 1) {
      const record = numstat[index];
      if (!record) continue;
      const [added, deleted, path] = record.split("\t");
      let countedPath = path;
      if (!countedPath && numstat[index + 1] && numstat[index + 2]) {
        countedPath = numstat[index + 2];
        index += 2;
      }
      if (!countedPath) continue;
      counts.set(countedPath, {
        additions: Number(added) || 0,
        deletions: Number(deleted) || 0,
        binary: added === "-" || deleted === "-"
      });
    }
    return files.map((file) => ({ ...file, ...(counts.get(file.path) ?? {}) }));
  }

  async mergeBase(repoRoot: string, base: string): Promise<string> {
    await this.requireBranch(repoRoot, base);
    return (await this.run(repoRoot, ["merge-base", base, "HEAD"])).stdout.trim();
  }

  async branchCommits(repoRoot: string, base: string): Promise<BranchCommit[]> {
    const mergeBase = await this.mergeBase(repoRoot, base);
    const output = (
      await this.run(repoRoot, [
        "log",
        "--format=%H%x09%h%x09%an%x09%aI%x09%s",
        `${mergeBase}..HEAD`
      ])
    ).stdout;
    return output
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const [sha, shortSha, author, authoredAt, subject] = line.split("\t");
        return sha && shortSha && author && authoredAt && subject
          ? [{ sha, shortSha, author, authoredAt, subject }]
          : [];
      });
  }

  async diff(repoRoot: string, base: string, path: string): Promise<string> {
    await this.requireBranch(repoRoot, base);
    await this.requireTrackedOrChangedPath(repoRoot, base, path);
    return (
      await this.run(repoRoot, [
        "diff",
        "--no-ext-diff",
        "--unified=80",
        "--find-renames",
        `${base}...HEAD`,
        "--",
        path
      ])
    ).stdout;
  }

  async source(repoRoot: string, path: string, revision = "HEAD"): Promise<string> {
    await this.requireRevision(repoRoot, revision);
    const tracked = await this.trackedFiles(repoRoot);
    if (!tracked.includes(path)) throw new GitError("The requested path is not tracked.", 1, "");
    return (await this.run(repoRoot, ["show", `${revision}:${path}`])).stdout;
  }

  async switchBranch(repoRoot: string, branchName: string): Promise<void> {
    const branches = await this.branches(repoRoot);
    const branch = branches.find((candidate) => candidate.name === branchName);
    if (!branch) throw new GitError("Unknown branch.", 1, "");
    if (!branch.remote) {
      await this.run(repoRoot, ["switch", branch.name]);
      return;
    }
    const local = branch.name.split("/").slice(1).join("/");
    if (!local) throw new GitError("Invalid remote branch.", 1, "");
    const existing = branches.find((candidate) => !candidate.remote && candidate.name === local);
    if (existing) await this.run(repoRoot, ["switch", local]);
    else await this.run(repoRoot, ["switch", "--track", "-c", local, branch.name]);
  }

  async blame(repoRoot: string, path: string, line: number, revision = "HEAD"): Promise<string> {
    await this.requireRevision(repoRoot, revision);
    if (!Number.isInteger(line) || line < 1) throw new GitError("Invalid line.", 1, "");
    return (
      await this.run(repoRoot, [
        "blame",
        "--line-porcelain",
        "-L",
        `${line},${line}`,
        revision,
        "--",
        path
      ])
    ).stdout;
  }

  async requireRevision(repoRoot: string, revision: string): Promise<void> {
    const branches = await this.branches(repoRoot);
    const allowed = new Set(["HEAD", ...branches.map((branch) => branch.name)]);
    if (!allowed.has(revision)) throw new GitError("Unknown revision.", 1, "");
  }

  private async requireBranch(repoRoot: string, branch: string): Promise<void> {
    if (!(await this.branches(repoRoot)).some((candidate) => candidate.name === branch)) {
      throw new GitError("Unknown base branch.", 1, "");
    }
  }

  private async requireTrackedOrChangedPath(
    repoRoot: string,
    base: string,
    path: string
  ): Promise<void> {
    const tracked = await this.trackedFiles(repoRoot);
    const changed = await this.changedFiles(repoRoot, base);
    if (!tracked.includes(path) && !changed.some((file) => file.path === path)) {
      throw new GitError("Unknown repository path.", 1, "");
    }
  }
}
