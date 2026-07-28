import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server/app.js";
import type { ServerConfig } from "../../src/server/config.js";
import { GitService } from "../../src/server/git/git-service.js";

export default async function setup() {
  process.env["LINEAGE_LOG_LEVEL"] = "silent";
  const stateDirectory = await mkdtemp(join(tmpdir(), "lineage-e2e-"));
  const hostileRepository = join(stateDirectory, "repositories", "hostile-review");
  await mkdir(join(hostileRepository, "src"), { recursive: true });
  const git = new GitService();
  await git.run(hostileRepository, ["init", "-b", "main"]);
  await git.run(hostileRepository, ["config", "user.name", "Hostile <img src=x onerror=window.__lineageXss=1>"]);
  await git.run(hostileRepository, ["config", "user.email", "hostile@example.test"]);
  await writeFile(
    join(hostileRepository, "src/payload.ts"),
    "export const payload = \"<img src=x onerror=window.__lineageXss=1>\";\n",
    "utf8"
  );
  await git.run(hostileRepository, ["add", "."]);
  await git.run(hostileRepository, ["commit", "-m", "Add <script>window.__lineageXss=1</script>"]);
  await git.run(hostileRepository, ["switch", "-c", "review/hostile"]);
  await writeFile(
    join(hostileRepository, "src/payload.ts"),
    "export const payload = \"<svg onload=window.__lineageXss=2>\";\n",
    "utf8"
  );
  await git.run(hostileRepository, ["add", "."]);
  await git.run(hostileRepository, ["commit", "-m", "Change <img src=x onerror=window.__lineageXss=3>"]);
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 3317,
    captureHost: "127.0.0.1",
    capturePort: 3318,
    stateDirectory,
    allowedRoots: ["/home/dean", stateDirectory],
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
  process.env["LINEAGE_E2E_HOSTILE_REPOSITORY"] = hostileRepository;
  return async () => {
    await built.app.close();
    await built.captureApp.close().catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true });
  };
}
