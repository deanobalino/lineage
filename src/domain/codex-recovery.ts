import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { ProvenanceSession } from "./models.js";
import { providerDisplayName } from "./models.js";
import { ProvenanceStore } from "./provenance-store.js";
import { parseTranscriptLine } from "./evidence.js";
import { stableId, uniqueSorted } from "./stable.js";

const MAX_TRANSCRIPT_FILES = 5_000;
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function jsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0 && files.length < MAX_TRANSCRIPT_FILES) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
      if (files.length >= MAX_TRANSCRIPT_FILES) break;
    }
  }
  return files.sort();
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function recoverCodexTranscripts(
  repoRoot: string,
  configuredRoots: string[]
): Promise<{ imported: number; scanned: number }> {
  const canonicalRepo = await realpath(repoRoot);
  const roots: string[] = [];
  for (const root of configuredRoots) {
    try {
      roots.push(await realpath(root));
    } catch {
      // Missing approved roots are ignored.
    }
  }
  const store = new ProvenanceStore(canonicalRepo);
  const existing = new Set((await store.sessions()).map((session) => session.sessionId));
  let imported = 0;
  let scanned = 0;
  for (const root of roots) {
    for (const candidate of await jsonlFiles(root)) {
      scanned += 1;
      const canonical = await realpath(candidate);
      if (!within(root, canonical) || (await stat(canonical)).size > MAX_TRANSCRIPT_BYTES) continue;
      const text = await readFile(canonical, "utf8");
      const lines = text.split("\n").filter(Boolean);
      let sessionId: string | undefined;
      let cwd: string | undefined;
      let model: string | undefined;
      const messages = [];
      const tools: string[] = [];
      const files: string[] = [];
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          continue;
        }
        const rootObject = object(parsed);
        const payload = object(rootObject["payload"]);
        if (rootObject["type"] === "session_meta") {
          if (typeof payload["id"] === "string") sessionId = payload["id"];
          if (typeof payload["cwd"] === "string") cwd = payload["cwd"];
          if (typeof payload["model"] === "string") model = payload["model"];
        }
        const message = parseTranscriptLine(line, String(index));
        if (message) {
          messages.push(message);
          if (message.role === "tool" && message.title !== "Tool result") {
            tools.push(message.title);
            try {
              const argumentsObject = object(JSON.parse(message.body) as unknown);
              for (const key of ["file_path", "path"]) {
                if (typeof argumentsObject[key] === "string") files.push(argumentsObject[key]);
              }
            } catch {
              // Tool arguments are not always JSON.
            }
          }
        }
      }
      if (!sessionId || existing.has(sessionId) || !cwd) continue;
      let canonicalCwd: string;
      try {
        canonicalCwd = await realpath(cwd);
      } catch {
        continue;
      }
      if (canonicalCwd !== canonicalRepo) continue;
      const prompt = [...messages].reverse().find((message) => message.role === "user")?.body ?? "";
      const finalMessage =
        [...messages].reverse().find((message) => message.role === "assistant")?.body ?? "";
      const provider = "codex";
      const session: ProvenanceSession = {
        provider,
        providerDisplayName: providerDisplayName(provider),
        sessionId,
        source: "codex-transcript-recovery",
        actor: "Codex",
        transcriptPath: canonical,
        humanReviewer: "Unknown",
        prompt,
        toolsUsed: uniqueSorted(tools),
        commandsRun: [],
        filesEdited: uniqueSorted(files),
        testsRun: [],
        testsResult: "unknown",
        permissionRequests: [],
        decisions: [],
        externalConstraints: [],
        lastAssistantMessage: finalMessage,
        gitDiff: "",
        reasoningSummary: prompt
          ? `Codex transcript recovery captured the prompt: ${prompt}`
          : "Recovered Codex transcript evidence.",
        lineRanges: uniqueSorted(files).map((file) => ({
          file,
          start: 1,
          end: 999,
          confidence: 0.72,
          label: "Recovered"
        })),
        rawTelemetryPayload: {
          recovery_id: stableId("codex-recovery", canonical, sessionId),
          transcript_messages: messages.length
        }
      };
      if (model) session.model = model;
      await store.writeSession(session);
      existing.add(sessionId);
      imported += 1;
    }
  }
  return { imported, scanned };
}
