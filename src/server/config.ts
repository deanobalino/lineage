import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  captureHost: string;
  capturePort: number;
  stateDirectory: string;
  allowedRoots: string[];
  transcriptRoots: string[];
  allowedHosts: string[];
  allowedOrigins: string[];
  sessionTtlMs: number;
  gitTimeoutMs: number;
  gitMaxBytes: number;
}

function paths(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(":")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(entry));
}

function integer(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function serverConfig(environment = process.env): ServerConfig {
  const port = integer(environment["LINEAGE_PORT"], 3217);
  const root = resolve(environment["LINEAGE_WORKSPACE"] ?? process.cwd());
  const allowedRoots = paths(environment["LINEAGE_ALLOWED_ROOTS"], [dirname(root)]);
  return {
    host: environment["LINEAGE_HOST"] ?? "127.0.0.1",
    port,
    captureHost: "127.0.0.1",
    capturePort: integer(environment["LINEAGE_CAPTURE_PORT"], port + 1),
    stateDirectory: resolve(
      environment["LINEAGE_STATE_DIR"] ?? join(homedir(), ".local", "state", "lineage")
    ),
    allowedRoots,
    transcriptRoots: paths(environment["LINEAGE_TRANSCRIPT_ROOTS"], [
      join(homedir(), ".codex", "sessions")
    ]),
    allowedHosts: [
      "localhost",
      "127.0.0.1",
      "[::1]",
      ...String(environment["LINEAGE_ALLOWED_HOSTS"] ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    ],
    allowedOrigins: [
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      ...String(environment["LINEAGE_ALLOWED_ORIGINS"] ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    ],
    sessionTtlMs: integer(environment["LINEAGE_SESSION_TTL_MS"], 8 * 60 * 60 * 1000),
    gitTimeoutMs: integer(environment["LINEAGE_GIT_TIMEOUT_MS"], 15_000),
    gitMaxBytes: integer(environment["LINEAGE_GIT_MAX_BYTES"], 16 * 1024 * 1024)
  };
}
