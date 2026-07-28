import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server/app.js";
import type { ServerConfig } from "../../src/server/config.js";

export default async function setup() {
  process.env["LINEAGE_LOG_LEVEL"] = "silent";
  const stateDirectory = await mkdtemp(join(tmpdir(), "lineage-e2e-"));
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 3317,
    captureHost: "127.0.0.1",
    capturePort: 3318,
    stateDirectory,
    allowedRoots: ["/home/dean"],
    transcriptRoots: [],
    allowedHosts: ["127.0.0.1", "localhost"],
    allowedOrigins: ["http://127.0.0.1:3317", "http://localhost:3317"],
    sessionTtlMs: 60 * 60 * 1000,
    gitTimeoutMs: 15_000,
    gitMaxBytes: 16 * 1024 * 1024
  };
  const built = await buildApp(config);
  await built.captureApp.listen({ host: config.captureHost, port: config.capturePort });
  await built.app.listen({ host: config.host, port: config.port });
  if (!built.bootstrap.operatorToken) throw new Error("E2E operator token was not created.");
  process.env["LINEAGE_E2E_OPERATOR_TOKEN"] = built.bootstrap.operatorToken;
  return async () => {
    await built.app.close();
    await built.captureApp.close().catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true });
  };
}
