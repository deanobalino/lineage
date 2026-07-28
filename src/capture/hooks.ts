import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWrite } from "../domain/provenance-store.js";

export type HarnessProvider = "codex" | "github-copilot";

export interface HarnessStatus {
  provider: HarnessProvider;
  configured: boolean;
  owned: boolean;
  path: string;
}

const markerStart = "# >>> lineage managed hooks >>>";
const markerEnd = "# <<< lineage managed hooks <<<";

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function codexHooks(command: string): string {
  const events = [
    ["SessionStart", 'matcher = "startup|resume|clear|compact"', 10],
    ["UserPromptSubmit", "", 10],
    ["PreToolUse", 'matcher = "Bash|apply_patch|Edit|Write|Read|mcp__.*"', 10],
    ["PermissionRequest", 'matcher = "Bash|apply_patch|Edit|Write|Read|mcp__.*"', 10],
    ["PostToolUse", 'matcher = "Bash|apply_patch|Edit|Write|Read|mcp__.*"', 10],
    ["Stop", "", 30]
  ] as const;
  const body = events
    .map(
      ([event, matcher, timeout]) => `[[hooks.${event}]]
${matcher}
[[hooks.${event}.hooks]]
type = "command"
command = ${quote(command)}
timeout = ${timeout}
statusMessage = "Lineage provenance capture"`
    )
    .join("\n\n");
  return `${markerStart}\n${body}\n${markerEnd}`;
}

export function copilotHooks(command: string): Record<string, unknown> {
  const hook = (event: string, matcher?: string) => ({
    type: "command",
    command,
    env: {
      LINEAGE_PROVIDER: "github-copilot",
      LINEAGE_HOOK_EVENT: event
    },
    timeoutSec: 30,
    ...(matcher ? { matcher } : {})
  });
  return {
    version: 1,
    hooks: {
      SessionStart: [hook("SessionStart")],
      UserPromptSubmit: [hook("UserPromptSubmit")],
      PreToolUse: [hook("PreToolUse", "*")],
      PermissionRequest: [hook("PermissionRequest", "*")],
      PostToolUse: [hook("PostToolUse", "*")],
      PostToolUseFailure: [hook("PostToolUseFailure", "*")],
      Stop: [hook("Stop")],
      SessionEnd: [hook("SessionEnd")]
    }
  };
}

function stripOwnedCodex(content: string): string {
  const marked = new RegExp(
    `${escapeRegex(markerStart)}[\\s\\S]*?${escapeRegex(markerEnd)}\\s*`,
    "g"
  );
  const lines = content.replace(marked, "").split("\n");
  const output: string[] = [];
  const topHook = /^\[\[hooks\.([A-Za-z0-9_-]+)\]\]\s*$/;
  const singleTable = /^\[[^\[].*\]\s*$/;
  for (let index = 0; index < lines.length; ) {
    if (!topHook.test(lines[index] ?? "")) {
      output.push(lines[index] ?? "");
      index += 1;
      continue;
    }
    let end = index + 1;
    while (
      end < lines.length &&
      !topHook.test(lines[end] ?? "") &&
      !singleTable.test(lines[end] ?? "")
    ) {
      end += 1;
    }
    const block = lines.slice(index, end);
    if (!block.join("\n").includes("lineage-capture")) output.push(...block);
    index = end;
  }
  return output.join("\n").trimEnd();
}

function enableCodexHooks(content: string): string {
  if (/^\[features\]\s*$/m.test(content)) {
    if (/^hooks\s*=/m.test(content)) {
      return content.replace(/^hooks\s*=.*$/m, "hooks = true");
    }
    return content.replace(/^\[features\]\s*$/m, "[features]\nhooks = true");
  }
  return `[features]\nhooks = true\n\n${content}`;
}

export async function installHarness(
  repoRoot: string,
  provider: HarnessProvider,
  command: string
): Promise<HarnessStatus> {
  const path =
    provider === "codex"
      ? join(repoRoot, ".codex", "config.toml")
      : join(repoRoot, ".github", "hooks", "lineage-copilot.json");
  await mkdir(dirname(path), { recursive: true });
  let original = "";
  try {
    original = await readFile(path, "utf8");
  } catch {
    original = provider === "github-copilot" ? "{}\n" : "";
  }
  const backup = `${path}.lineage-backup-${Date.now()}`;
  await atomicWrite(backup, original, 0o600);
  try {
    if (provider === "codex") {
      const clean = enableCodexHooks(stripOwnedCodex(original));
      await atomicWrite(path, `${clean.trimEnd()}\n\n${codexHooks(command)}\n`, 0o600);
    } else {
      let document: Record<string, unknown>;
      try {
        document = JSON.parse(original) as Record<string, unknown>;
      } catch {
        document = {};
      }
      const existingHooks =
        document["hooks"] && typeof document["hooks"] === "object"
          ? document["hooks"] as Record<string, unknown>
          : {};
      const owned = (copilotHooks(command)["hooks"] ?? {}) as Record<string, unknown>;
      await atomicWrite(
        path,
        `${JSON.stringify({ ...document, version: 1, hooks: { ...existingHooks, ...owned } }, null, 2)}\n`,
        0o600
      );
    }
    return harnessStatus(repoRoot, provider);
  } catch (error) {
    await atomicWrite(path, original, 0o600);
    throw error;
  }
}

export async function harnessStatus(
  repoRoot: string,
  provider: HarnessProvider
): Promise<HarnessStatus> {
  const path =
    provider === "codex"
      ? join(repoRoot, ".codex", "config.toml")
      : join(repoRoot, ".github", "hooks", "lineage-copilot.json");
  try {
    const content = await readFile(path, "utf8");
    return {
      provider,
      configured: true,
      owned:
        provider === "codex"
          ? content.includes(markerStart)
          : content.includes('"LINEAGE_PROVIDER": "github-copilot"'),
      path
    };
  } catch {
    return { provider, configured: false, owned: false, path };
  }
}

export async function installCaptureExecutable(
  source: string,
  stateDirectory: string
): Promise<string> {
  await stat(source);
  const directory = join(stateDirectory, "bin");
  const target = join(directory, "lineage-capture.mjs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const data = await readFile(source);
  await atomicWrite(target, data, 0o700);
  return target;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
