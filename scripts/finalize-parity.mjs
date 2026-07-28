#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../docs/parity/web-parity-matrix.json", import.meta.url);
const matrix = JSON.parse(await readFile(path, "utf8"));

const evidenceByRow = {
  "REPO-001": ["tests/integration/server/app.test.ts#persists verifier-only credentials and remembered repositories across restart"],
  "REPO-002": ["tests/integration/server/app.test.ts#forgets only registry state, re-adds existing provenance, and creates a real demo"],
  "REPO-003": ["tests/integration/server/app.test.ts#serves Review, Explore, explanations, branch changes, and exports from real Git"],
  "REPO-004": ["tests/integration/server/app.test.ts#forgets only registry state, re-adds existing provenance, and creates a real demo"],
  "GIT-001": ["tests/integration/server/app.test.ts#serves Review, Explore, explanations, branch changes, and exports from real Git"],
  "GIT-002": ["tests/unit/server/git.test.ts#uses the current branch as the empty comparison fallback"],
  "GIT-003": ["tests/unit/server/git.test.ts#creates a local tracking branch from a remote ref"],
  "GIT-004": ["tests/unit/server/git.test.ts#reads blame from the base revision after a line is deleted"],
  "REVIEW-001": ["tests/unit/server/git.test.ts#attributes edited rename churn and counts feature-only commits"],
  "REVIEW-002": ["tests/unit/server/git.test.ts#attributes edited rename churn and counts feature-only commits"],
  "REVIEW-003": ["tests/integration/server/app.test.ts#serves Review, Explore, explanations, branch changes, and exports from real Git"],
  "REVIEW-004": ["tests/e2e/web.spec.ts#reviews a real branch and opens its recorded evidence"],
  "REVIEW-005": ["tests/integration/server/app.test.ts#serves Review, Explore, explanations, branch changes, and exports from real Git"],
  "EXPLORE-001": ["tests/e2e/web.spec.ts#operates repository controls and evidence workflows at every viewport"],
  "EXPLORE-002": ["tests/e2e/web.spec.ts#operates repository controls and evidence workflows at every viewport"],
  "EXPLORE-003": ["tests/e2e/web.spec.ts#operates repository controls and evidence workflows at every viewport"],
  "EXPLAIN-001": ["tests/unit/domain/compatibility.test.ts#uses direct ranges before commit fallback and produces bounded Git fallback"],
  "EXPLAIN-002": ["tests/unit/domain/compatibility.test.ts#uses direct ranges before commit fallback and produces bounded Git fallback"],
  "EXPLAIN-003": ["tests/unit/domain/compatibility.test.ts#reduces out-of-order input deterministically and respects provider finalization"],
  "EXPLAIN-004": ["tests/unit/domain/compatibility.test.ts#uses direct ranges before commit fallback and produces bounded Git fallback"],
  "EXPLAIN-005": ["tests/unit/domain/compatibility.test.ts#uses direct ranges before commit fallback and produces bounded Git fallback"],
  "DATA-001": ["tests/unit/domain/store.test.ts#reads valid JSONL in deterministic file order and skips malformed lines"],
  "DATA-002": ["tests/unit/domain/models.test.ts#defaults historical session fields and retains unknown fields"],
  "DATA-003": ["tests/unit/domain/models.test.ts#preserves recursive unknown provider payload values"],
  "LINK-001": ["tests/unit/domain/compatibility.test.ts#reduces out-of-order input deterministically and respects provider finalization"],
  "LINK-002": ["tests/unit/domain/providers.test.ts#normalizes permission requests and failed tool completions"],
  "LINK-003": ["tests/unit/domain/compatibility.test.ts#reduces out-of-order input deterministically and respects provider finalization"],
  "GRAPH-001": ["tests/unit/domain/compatibility.test.ts#builds byte-stable graph identities with the 200-line expansion ceiling"],
  "GRAPH-002": ["tests/unit/domain/compatibility.test.ts#builds byte-stable graph identities with the 200-line expansion ceiling"],
  "EVIDENCE-001": ["tests/unit/domain/compatibility.test.ts#redacts the frozen policy and loads provider transcript messages"],
  "EVIDENCE-002": ["tests/unit/domain/compatibility.test.ts#redacts the frozen policy and loads provider transcript messages"],
  "EVIDENCE-003": ["tests/e2e/web.spec.ts#operates repository controls and evidence workflows at every viewport"],
  "EXPORT-001": ["tests/unit/domain/compatibility.test.ts#exports redacted Markdown, JSON, and deterministic Agent Trace JSONL"],
  "EXPORT-002": ["tests/unit/domain/compatibility.test.ts#exports redacted Markdown, JSON, and deterministic Agent Trace JSONL"],
  "EXPORT-003": ["tests/unit/domain/compatibility.test.ts#exports redacted Markdown, JSON, and deterministic Agent Trace JSONL"],
  "CAPTURE-001": ["tests/unit/capture/outbox.test.ts#preserves unrelated Codex and Copilot configuration and remains idempotent"],
  "CAPTURE-002": ["tests/integration/capture/capture.test.ts#ingests idempotently and preserves Codex and Copilot finalization semantics"],
  "CAPTURE-003": ["tests/integration/capture/capture.test.ts#ingests idempotently and preserves Codex and Copilot finalization semantics"],
  "CAPTURE-004": ["tests/unit/capture/outbox.test.ts#stages raw input outside the replay set and finalizes it atomically"],
  "CAPTURE-005": ["tests/integration/capture/capture.test.ts#runs capture diagnostics through the bundled command"],
  "CAPTURE-006": ["tests/integration/capture/capture.test.ts#replays queued events, dead-letters unregistered repositories, and reports health"],
  "WEB-001": ["tests/e2e/web.spec.ts#reviews a real branch and opens its recorded evidence"],
  "WEB-002": ["tests/e2e/web.spec.ts#operates repository controls and evidence workflows at every viewport"],
  "SECURITY-001": ["tests/integration/server/app.test.ts#rejects outside roots, symlink escapes, bad Host/Origin, missing CSRF, and old tokens"],
  "CUTOVER-001": ["docs/parity/cutover-report.md#Web-only cutover report"]
};

for (const row of matrix.rows) {
  const evidence = evidenceByRow[row.id];
  if (!evidence) throw new Error(`No replacement evidence mapping for ${row.id}`);
  row.replacementEvidence = evidence;
  row.status = "verified";
}

await writeFile(path, `${JSON.stringify(matrix, null, 2)}\n`);
