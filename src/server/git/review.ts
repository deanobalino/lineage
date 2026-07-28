import type { ProvenanceSession } from "../../domain/models.js";
import type { ChangedFile, GitService } from "./git-service.js";

export interface DiffLine {
  kind: "context" | "addition" | "deletion" | "meta";
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface DiffHunk {
  id: string;
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export function parseUnifiedDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  const lines = (diff.endsWith("\n") ? diff.slice(0, -1) : diff).split("\n");
  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = /@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
      oldLine = Number(match?.[1] ?? 0);
      newLine = Number(match?.[2] ?? 0);
      hunk = {
        id: `hunk-${hunks.length + 1}`,
        header: line,
        oldStart: oldLine,
        newStart: newLine,
        lines: []
      };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      hunk.lines.push({ kind: "addition", newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      hunk.lines.push({ kind: "deletion", oldLine, text: line.slice(1) });
      oldLine += 1;
    } else if (line.startsWith("\\")) {
      hunk.lines.push({ kind: "meta", text: line });
    } else {
      hunk.lines.push({ kind: "context", oldLine, newLine, text: line.slice(1) });
      oldLine += 1;
      newLine += 1;
    }
  }
  return hunks;
}

export function sessionsForFile(
  sessions: ProvenanceSession[],
  path: string
): ProvenanceSession[] {
  return sessions.filter(
    (session) =>
      session.filesEdited.includes(path) ||
      session.lineRanges.some((range) => range.file === path)
  );
}

export async function reviewMetrics(
  git: GitService,
  repoRoot: string,
  base: string,
  files: ChangedFile[],
  sessions: ProvenanceSession[]
): Promise<{
  commits: number;
  files: number;
  additions: number;
  deletions: number;
  sessions: number;
  explainedPercent: number;
}> {
  const commits = Number(
    (await git.run(repoRoot, ["rev-list", "--count", `${base}...HEAD`])).stdout.trim()
  ) || 0;
  const explained = files.filter((file) => sessionsForFile(sessions, file.path).length > 0);
  return {
    commits,
    files: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    sessions: sessions.length,
    explainedPercent: files.length === 0 ? 0 : Math.round((explained.length / files.length) * 100)
  };
}

export function parseBlame(raw: string, line: number, content: string) {
  const lines = raw.split("\n");
  const sha = lines[0]?.split(" ")[0] ?? "Unknown";
  const field = (name: string) =>
    lines.find((entry) => entry.startsWith(`${name} `))?.slice(name.length + 1);
  const result: {
    commitSha: string;
    commitSummary: string;
    author: string;
    authorEmail?: string;
    authoredAt?: string;
    line: number;
    content: string;
  } = {
    commitSha: sha,
    commitSummary: field("summary") ?? "Unknown",
    author: field("author") ?? "Unknown",
    line,
    content
  };
  const authorEmail = field("author-mail")?.replace(/^<|>$/g, "");
  const authorTime = field("author-time");
  if (authorEmail) result.authorEmail = authorEmail;
  if (authorTime) result.authoredAt = new Date(Number(authorTime) * 1000).toISOString();
  return result;
}
