import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWrite } from "../domain/provenance-store.js";
import { inspectContainedPath } from "../shared/path-safety.js";

export type HarnessProvider = "codex" | "github-copilot";

export interface HarnessStatus {
  provider: HarnessProvider;
  configured: boolean;
  owned: boolean;
  path: string;
}

const markerStart = "# >>> lineage managed hooks >>>";
const markerEnd = "# <<< lineage managed hooks <<<";
const codexEvents = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop"
] as const;

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
  const lines = content.split("\n");
  const start = lines.findIndex((line) => /^\[features\]\s*$/.test(line));
  if (start < 0) return `[features]\nhooks = true\n\n${content}`;
  const end = lines.findIndex((line, index) => index > start && /^\[\[?.+\]?\]\s*$/.test(line));
  const boundary = end < 0 ? lines.length : end;
  const hook = lines.findIndex(
    (line, index) => index > start && index < boundary && /^hooks\s*=/.test(line)
  );
  if (hook >= 0) lines[hook] = "hooks = true";
  else lines.splice(start + 1, 0, "hooks = true");
  return lines.join("\n");
}

export async function installHarness(
  repoRoot: string,
  provider: HarnessProvider,
  command: string
): Promise<HarnessStatus> {
  const relativePath =
    provider === "codex"
      ? ".codex/config.toml"
      : ".github/hooks/lineage-copilot.json";
  const inspected = await inspectContainedPath(repoRoot, relativePath);
  if (inspected.status === "unsafe" || inspected.status === "directory" || inspected.status === "other") {
    throw new Error("Harness configuration path is unsafe.");
  }
  const path =
    inspected.path;
  await mkdir(dirname(path), { recursive: true });
  const created = await inspectContainedPath(repoRoot, relativePath);
  if (created.status === "unsafe" || created.status === "directory" || created.status === "other") {
    throw new Error("Harness configuration path is unsafe.");
  }
  let original = "";
  try {
    original = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    original = provider === "github-copilot" ? "{}\n" : "";
  }
  const backup = `${path}.lineage-backup-${Date.now()}`;
  await atomicWrite(backup, original, 0o600);
  try {
    if (provider === "codex") {
      const clean = enableCodexHooks(stripOwnedCodex(original));
      const generated = `${clean.trimEnd()}\n\n${codexHooks(command)}\n`;
      validateHarnessConfiguration(provider, generated, command);
      await atomicWrite(path, generated, 0o600);
    } else {
      const document = JSON.parse(original) as Record<string, unknown>;
      if (!document || typeof document !== "object" || Array.isArray(document)) {
        throw new Error("Copilot hook configuration must be a JSON object.");
      }
      const existingHooks =
        document["hooks"] &&
        typeof document["hooks"] === "object" &&
        !Array.isArray(document["hooks"])
          ? document["hooks"] as Record<string, unknown>
          : {};
      const owned = (copilotHooks(command)["hooks"] ?? {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...existingHooks };
      for (const [event, value] of Object.entries(owned)) {
        if (event in existingHooks && !Array.isArray(existingHooks[event])) {
          throw new Error(`Copilot ${event} hooks must be an array.`);
        }
        const unrelated = Array.isArray(existingHooks[event])
          ? existingHooks[event].filter((entry) => !isOwnedCopilotHook(entry))
          : [];
        merged[event] = [...unrelated, ...(value as unknown[])];
      }
      const generated = `${JSON.stringify(
        { ...document, version: 1, hooks: merged },
        null,
        2
      )}\n`;
      validateHarnessConfiguration(provider, generated, command);
      await atomicWrite(
        path,
        generated,
        0o600
      );
    }
    const installed = await harnessStatus(repoRoot, provider);
    if (!installed.configured || !installed.owned) {
      throw new Error("Harness configuration validation failed after installation.");
    }
    return installed;
  } catch (error) {
    await atomicWrite(path, original, 0o600);
    throw error;
  }
}

export function validateHarnessConfiguration(
  provider: HarnessProvider,
  content: string,
  command: string
): void {
  if (provider === "github-copilot") {
    const document = JSON.parse(content) as Record<string, unknown>;
    const hooks = document["hooks"];
    if (document["version"] !== 1 || !hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
      throw new Error("Generated Copilot hook configuration is invalid.");
    }
    for (const event of Object.keys((copilotHooks(command)["hooks"] ?? {}) as object)) {
      const values = (hooks as Record<string, unknown>)[event];
      const owned = Array.isArray(values)
        ? values.filter((value) => isOwnedCopilotHook(value))
        : [];
      if (
        owned.length !== 1 ||
        (owned[0] as Record<string, unknown>)["command"] !== command
      ) {
        throw new Error(`Generated Copilot ${event} hook is invalid.`);
      }
    }
    return;
  }
  validateTomlShape(content);
  if (!/^\[features\]$/m.test(content) || !/^hooks\s*=\s*true$/m.test(content)) {
    throw new Error("Generated Codex hook feature configuration is invalid.");
  }
  for (const event of codexEvents) {
    const blocks = [...content.matchAll(
      new RegExp(
        `\\[\\[hooks\\.${event}\\]\\][\\s\\S]*?\\[\\[hooks\\.${event}\\.hooks\\]\\]([\\s\\S]*?)(?=\\[\\[hooks\\.|${escapeRegex(markerEnd)})`,
        "g"
      )
    )];
    if (
      blocks.length !== 1 ||
      !new RegExp(`^command\\s*=\\s*${escapeRegex(quote(command))}$`, "m")
        .test(blocks[0]?.[1] ?? "")
    ) {
      throw new Error(`Generated Codex ${event} hook is invalid.`);
    }
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

function isOwnedCopilotHook(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hook = value as Record<string, unknown>;
  const environment = hook["env"];
  return Boolean(
    environment &&
    typeof environment === "object" &&
    !Array.isArray(environment) &&
    (environment as Record<string, unknown>)["LINEAGE_PROVIDER"] === "github-copilot"
  );
}

function validateTomlShape(content: string): void {
  let continuation = 0;
  for (const sourceLine of content.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (continuation === 0 && /^\[\[?[A-Za-z0-9_.-]+\]?\]$/.test(line)) continue;
    if (continuation === 0 && !/^[A-Za-z0-9_.-]+\s*=/.test(line)) {
      throw new Error("Generated Codex TOML contains an invalid statement.");
    }
    continuation += bracketDelta(line);
    if (continuation < 0) throw new Error("Generated Codex TOML has unbalanced brackets.");
  }
  if (continuation !== 0) throw new Error("Generated Codex TOML has unbalanced brackets.");
}

function bracketDelta(line: string): number {
  let delta = 0;
  let quoteCharacter = "";
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quoteCharacter) {
      escaped = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quoteCharacter = quoteCharacter === character ? "" : quoteCharacter || character;
      continue;
    }
    if (quoteCharacter) continue;
    if (character === "[" || character === "{") delta += 1;
    if (character === "]" || character === "}") delta -= 1;
  }
  return delta;
}
