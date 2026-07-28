import { spawnSync } from "node:child_process";
import { readSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  linkRepository,
  ProvenanceStore,
  recoverCodexTranscripts
} from "../domain/index.js";
import {
  captureServerHealth,
  readCaptureClientConfig,
  wakeCapture,
  type CaptureClientConfig
} from "./client.js";
import {
  createEnvelope,
  MAX_CAPTURE_INPUT_BYTES
} from "./envelope.js";
import { CaptureOutbox } from "./outbox.js";
import { BaselineStore, finalizeGitEvidence } from "./snapshot.js";

const stateDirectory = resolve(
  process.env["LINEAGE_STATE_DIR"] ?? join(homedir(), ".local", "state", "lineage")
);
const command = process.argv[2];

if (command?.startsWith("--")) {
  const exitCode = await runAdmin(command, process.argv.slice(3));
  process.exitCode = exitCode;
} else {
  await runHook();
  process.exitCode = 0;
}

async function runHook(): Promise<void> {
  try {
    const input = readStdin();
    const object = input.length > 0 ? JSON.parse(input) as unknown : {};
    const cwd =
      stringFrom(object, ["cwd"]) ??
      process.cwd() ??
      process.env["PWD"]!;
    const repoRoot = resolveRepository(cwd);
    const config = await captureConfigOrDefault();
    const outbox = new CaptureOutbox(config.outboxDirectory);
    const envelope = createEnvelope({
      input: object,
      cwd,
      repoRoot,
      environment: process.env
    });
    await outbox.stage(envelope);
    let finalized = envelope;
    try {
      finalized = await finalizeGitEvidence(
        envelope,
        new BaselineStore(config.baselineDirectory)
      );
    } catch (error) {
      finalized = {
        ...envelope,
        evidenceComplete: false,
        evidenceIssue:
          error instanceof Error ? error.message : "Git evidence collection failed."
      };
    }
    await outbox.finalizeStaged(finalized);
    if (!config.token) {
      diagnostic("capture server is not configured; event queued");
      return;
    }
    const result = await wakeCapture(finalized, config);
    if (result !== "delivered") {
      diagnostic(
        result === "permanent"
          ? "capture server rejected an event; it was moved to dead letters"
          : "capture server unavailable; event queued for replay"
      );
    } else if (process.env["LINEAGE_CAPTURE_VERBOSE"] === "1") {
      process.stdout.write(
        `lineage-capture: recorded ${finalized.providerEventName} from ${finalized.provider}\n`
      );
    }
  } catch (error) {
    diagnostic(error instanceof Error ? error.message : "capture failed");
  }
}

async function runAdmin(command: string, args: string[]): Promise<number> {
  try {
    if (command === "--doctor") {
      const config = await readCaptureClientConfig(stateDirectory);
      const root = resolveRepository(args[0] ?? process.cwd());
      const outbox = new CaptureOutbox(config.outboxDirectory);
      const started = performance.now();
      await mkdir(join(config.outboxDirectory, "probe"), { recursive: true, mode: 0o700 });
      const elapsed = Math.round(performance.now() - started);
      const status = await outbox.status();
      const server = await captureServerHealth(config);
      const localPending = status.pending + status.staging + status.claimed;
      const healthy =
        localPending === 0 &&
        status.deadLetters === 0 &&
        !status.quotaExceeded &&
        server.pending === 0 &&
        server.claimed === 0 &&
        server.deadLetters === 0 &&
        server.incompleteEvidence === 0 &&
        !["off", "interrupted", "pending", "replaying", "degraded"].includes(server.state);
      process.stdout.write(
        `lineage-capture doctor: ${healthy ? "ok" : "failed"} ${root}\noutbox=${config.outboxDirectory}\nlocal_pending=${localPending}\nlocal_dead_letters=${status.deadLetters}\nserver_state=${server.state}\nserver_pending=${server.pending + server.claimed}\nserver_dead_letters=${server.deadLetters}\nincomplete_evidence=${server.incompleteEvidence}\nstorage_probe_ms=${elapsed}\n`
      );
      return healthy ? 0 : 1;
    }
    if (command === "--link") {
      const root = resolveRepository(args[0] ?? process.cwd());
      const sessions = await linkRepository(new ProvenanceStore(root));
      process.stdout.write(`lineage-capture link: ok ${root} (${sessions.length} sessions)\n`);
      return 0;
    }
    if (command === "--verify-line") {
      if (args.length < 3) {
        diagnostic("verify-line expects <repo> <file> <text-marker>");
        return 2;
      }
      const root = resolveRepository(args[0]!);
      const source = await import("node:fs/promises").then(({ readFile }) =>
        readFile(join(root, args[1]!), "utf8")
      );
      const lines = source.split(/\r?\n/);
      const marker = args.slice(2).join(" ");
      const index = lines.findIndex((line) => line.includes(marker));
      if (index < 0) {
        diagnostic("verify-line marker not found");
        return 1;
      }
      const sessions = await new ProvenanceStore(root).matchingSessions(args[1]!, index + 1);
      const blame = spawnSync(
        "git",
        ["-C", root, "blame", "--line-porcelain", "-L", `${index + 1},${index + 1}`, "HEAD", "--", args[1]!],
        { encoding: "utf8", timeout: 500 }
      );
      if (blame.status !== 0) throw new Error("git blame failed");
      const commit = String(blame.stdout).split(/\s/, 1)[0] ?? "NONE";
      const session = sessions[0];
      process.stdout.write(
        `line=${index + 1}\ncommit=${commit}\nprovider=${session?.providerDisplayName ?? "NONE"}\nsession=${session?.sessionId ?? "NONE"}\nconfidence=${session ? `Recorded ${session.providerDisplayName} provenance` : "Inferred from Git history"}\n`
      );
      return sessions.length > 0 ? 0 : 1;
    }
    if (command === "--recover-codex") {
      const root = resolveRepository(args[0] ?? process.cwd());
      const transcriptRoots = String(
        process.env["LINEAGE_TRANSCRIPT_ROOTS"] ??
          join(homedir(), ".codex", "sessions")
      ).split(":").filter(Boolean);
      const result = await recoverCodexTranscripts(root, transcriptRoots);
      process.stdout.write(
        `lineage-capture recover-codex: imported ${result.imported} sessions for ${root}\n`
      );
      return 0;
    }
    diagnostic(`unknown command: ${command}`);
    return 2;
  } catch (error) {
    diagnostic(error instanceof Error ? error.message : "admin command failed");
    return 1;
  }
}

function readStdin(): string {
  const chunks: Buffer[] = [];
  let bytes = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const read = readSync(0, chunk, 0, chunk.length, null);
    if (read === 0) break;
    bytes += read;
    if (bytes > MAX_CAPTURE_INPUT_BYTES) {
      throw new Error("hook input exceeds the capture limit");
    }
    chunks.push(chunk.subarray(0, read));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function resolveRepository(path: string): string {
  const result = spawnSync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 200
  });
  if (result.status !== 0) throw new Error("not inside a Git repository");
  return String(result.stdout).trim();
}

async function captureConfigOrDefault(): Promise<CaptureClientConfig> {
  try {
    return await readCaptureClientConfig(stateDirectory);
  } catch {
    return {
      version: 1,
      endpoint: "http://127.0.0.1:3218/api/v1/capture",
      token: "",
      outboxDirectory: join(stateDirectory, "capture-outbox"),
      baselineDirectory: join(stateDirectory, "capture-baselines")
    };
  }
}

function stringFrom(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = object[key];
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return undefined;
}

function diagnostic(message: string): void {
  process.stderr.write(`lineage-capture: ${message}\n`);
}
