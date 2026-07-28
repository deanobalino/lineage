#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: repoRoot,
  encoding: "utf8"
})
  .split("\0")
  .filter(Boolean);

const failures = [];
const forbiddenRoots = new Set(["Sources", "Tests", "lineage-app"]);
for (const path of tracked) {
  const parts = path.split("/");
  if (
    extname(path).toLowerCase() === ".swift" ||
    basename(path) === "Package.swift" ||
    forbiddenRoots.has(parts[0] ?? "") ||
    path === "scripts/build-app.sh"
  ) {
    failures.push(`native artifact is tracked: ${path}`);
  }
}

const activeConfiguration = tracked.filter(
  (path) =>
    path === "package.json" ||
    path === "README.md" ||
    path.startsWith(".github/workflows/") ||
    path.startsWith("ops/")
);
const nativeCommand = /\b(?:swift\s+(?:build|test|run|package)|xcodebuild|xcrun)\b/i;
for (const path of activeConfiguration) {
  const content = readFileSync(resolve(repoRoot, path.split("/").join(sep)), "utf8");
  if (nativeCommand.test(content)) {
    failures.push(`native toolchain command remains in active configuration: ${path}`);
  }
}

const report = {
  schemaVersion: 1,
  trackedFiles: tracked.length,
  swiftFree: failures.length === 0,
  failures
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.swiftFree ? 0 : 1;
