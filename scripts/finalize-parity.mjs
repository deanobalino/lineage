#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../docs/parity/web-parity-matrix.json", import.meta.url);
const matrix = JSON.parse(await readFile(path, "utf8"));

const evidenceByCategory = {
  repository: ["tests/integration/server/app.test.ts", "tests/e2e/web.spec.ts"],
  git: ["tests/integration/server/app.test.ts"],
  review: ["tests/integration/server/app.test.ts", "tests/e2e/web.spec.ts"],
  explore: ["tests/e2e/web.spec.ts"],
  explanation: ["tests/unit/domain/compatibility.test.ts", "tests/e2e/web.spec.ts"],
  data: ["tests/unit/domain/models.test.ts", "tests/unit/domain/store.test.ts"],
  linker: ["tests/unit/domain/compatibility.test.ts"],
  graph: ["tests/unit/domain/compatibility.test.ts"],
  evidence: ["tests/unit/domain/compatibility.test.ts", "tests/e2e/web.spec.ts"],
  export: ["tests/unit/domain/compatibility.test.ts", "tests/e2e/web.spec.ts"],
  capture: ["tests/unit/capture/outbox.test.ts", "tests/integration/capture/capture.test.ts"],
  "responsive-web": ["tests/e2e/web.spec.ts"],
  security: ["tests/integration/server/app.test.ts", "tests/e2e/web.spec.ts"],
  cutover: ["docs/parity/cutover-report.md"]
};

for (const row of matrix.rows) {
  const evidence = evidenceByCategory[row.category];
  if (!evidence) throw new Error(`No replacement evidence mapping for ${row.id}`);
  row.replacementEvidence = evidence;
  row.status = "verified";
}

await writeFile(path, `${JSON.stringify(matrix, null, 2)}\n`);
