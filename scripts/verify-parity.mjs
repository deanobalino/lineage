#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const matrixPath = join(repoRoot, "docs/parity/web-parity-matrix.json");
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return args[index + 1];
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function absolute(path) {
  return isAbsolute(path) ? path : join(repoRoot, path);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const failures = [];
const matrix = readJSON(matrixPath);
const manifestPath = absolute(matrix.fixtureManifest);
const manifest = readJSON(manifestPath);

if (matrix.schemaVersion !== 1) failures.push("unsupported parity matrix schema");
if (manifest.schemaVersion !== 1) failures.push("unsupported fixture manifest schema");
if (matrix.baselineCommit !== manifest.baselineCommit) {
  failures.push("matrix and fixture manifest baseline commits differ");
}
if (!/^[0-9a-f]{40}$/.test(matrix.baselineCommit ?? "")) {
  failures.push("baseline commit must be a full lowercase Git SHA");
}

const rowIDs = new Set();
for (const row of matrix.rows ?? []) {
  if (!row.id || rowIDs.has(row.id)) failures.push(`duplicate or missing row id: ${row.id ?? "<missing>"}`);
  rowIDs.add(row.id);
  if (!row.capability) failures.push(`${row.id}: capability is missing`);
  if (!Array.isArray(row.legacyEvidence) || row.legacyEvidence.length === 0) {
    failures.push(`${row.id}: legacy evidence is missing`);
  }
  if (row.status !== matrix.cutoverPolicy.requiredStatus) {
    failures.push(`${row.id}: status is ${row.status ?? "<missing>"}`);
  }
  if (!Array.isArray(row.replacementEvidence) || row.replacementEvidence.length === 0) {
    failures.push(`${row.id}: replacement evidence is missing`);
  } else {
    for (const evidence of row.replacementEvidence) {
      const evidencePath = String(evidence).split("#", 1)[0].split(":", 1)[0];
      if (evidencePath && !existsSync(absolute(evidencePath))) {
        failures.push(`${row.id}: replacement evidence does not exist: ${evidence}`);
      }
    }
  }
}

for (const fixture of manifest.files ?? []) {
  const path = absolute(fixture.path);
  if (!existsSync(path)) {
    failures.push(`fixture is missing: ${fixture.path}`);
    continue;
  }
  const actual = sha256(path);
  if (actual !== fixture.sha256) {
    failures.push(`fixture checksum mismatch: ${fixture.path}`);
  }
}

const oracleOption =
  option("--oracle") ??
  process.env.LINEAGE_ORACLE_OUTPUT_DIR ??
  matrix.oracleArtifact;
const oraclePath = oracleOption
  ? (oracleOption.endsWith(".json") ? absolute(oracleOption) : join(absolute(oracleOption), matrix.oracleArtifact.split("/").at(-1)))
  : undefined;
if (!oraclePath || !existsSync(oraclePath)) {
  failures.push("retained compatibility oracle is missing");
} else {
  const oracle = readJSON(oraclePath);
  if (oracle.schema_version !== 1 || oracle.baseline !== "swift-lineage-core") {
    failures.push("retained compatibility oracle has an unsupported contract");
  }
}

const report = {
  schemaVersion: 1,
  baselineCommit: matrix.baselineCommit,
  fixtureManifest: matrix.fixtureManifest,
  rowsTotal: matrix.rows?.length ?? 0,
  rowsVerified: (matrix.rows ?? []).filter((row) => row.status === "verified" && row.replacementEvidence?.length > 0).length,
  oraclePresent: Boolean(oraclePath && existsSync(oraclePath)),
  cutoverReady: failures.length === 0,
  failures
};

const output = option("--output");
if (output) writeFileSync(absolute(output), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.cutoverReady ? 0 : 1;
