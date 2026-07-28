# Lineage web replacement parity matrix

This inventory is the hard cutover gate for the web-only replacement. The machine-readable authority is [`web-parity-matrix.json`](./web-parity-matrix.json); this document explains how to maintain it.

Baseline Swift commit: `105ef5d900a3511496f5b8a39d8ee70b1212bffa`

Current gate state: **GREEN**. All 45 rows name replacement evidence and are machine-verified against the pinned fixture manifest and retained normalized oracle.

## Evidence rules

- `legacyEvidence` identifies the tracked Swift behavior, a committed fixture, or an approved product-contract addition.
- `replacementEvidence` must identify a committed test, retained browser observation, or generated oracle comparison that proves the web equivalent.
- A row becomes `verified` only when its replacement evidence exists and the named check is green.
- `blocked`, `not-applicable`, blanket waivers, and missing evidence do not satisfy a required row.
- `node scripts/verify-parity.mjs` validates fixture checksums and the complete matrix. It deliberately exits non-zero while any row remains pending.
- The normalized Swift oracle is generated on a Swift-capable macOS runner and retained as `oracle/normalized.json`. The current VPS does not need Swift.

## Capability coverage

| Category | IDs | Coverage frozen |
|---|---|---|
| Repository lifecycle | REPO-001 - REPO-004 | Open, remember, restore, forget, refresh, and demo reset |
| Git behavior | GIT-001 - GIT-004 | Tracked files, refs, base choice, switching, and blame |
| Review | REVIEW-001 - REVIEW-005 | Metrics, statuses, hunks, provenance markers, and explanations |
| Explore | EXPLORE-001 - EXPLORE-003 | Tree search, source, line selection, and range navigation |
| Explanations | EXPLAIN-001 - EXPLAIN-005 | Matching, answers, decisions, evidence, risk, and follow-ups |
| Durable data | DATA-001 - DATA-003 | Tolerant events/sessions and provider-native JSON |
| Linker | LINK-001 - LINK-003 | Ordering, decisions, constraints, and inferred ranges |
| Graph | GRAPH-001 - GRAPH-002 | Stable IDs, nodes, edges, and navigation |
| Session evidence | EVIDENCE-001 - EVIDENCE-003 | Redaction, transcript parsing, timelines, and touched ranges |
| Exports | EXPORT-001 - EXPORT-003 | Explanation, session, and Agent Trace formats |
| Capture | CAPTURE-001 - CAPTURE-006 | Hooks, adapters, lifecycle, baselines, diagnostics, and reliable replay |
| Responsive web | WEB-001 - WEB-002 | Desktop workspace plus full tablet/phone capability |
| Security and cutover | SECURITY-001, CUTOVER-001 | Trust boundaries and the no-early-deletion gate |

## Characterization corpus

The committed corpus under `tests/fixtures/compatibility` includes:

- event JSONL with historical defaults, an intentionally malformed line, unknown native payload data, Codex decisions/constraints, and Copilot Stop/SessionEnd;
- a historical session missing optional fields;
- a provider transcript with user, assistant, tool-call, and tool-result records;
- secret-redaction examples;
- a checksummed manifest tied to the Swift baseline.

`CompatibilityOracleTests` loads this corpus through the existing Swift readers, linker, graph, evidence, redaction, hook configuration, and Agent Trace exporter. Setting `LINEAGE_ORACLE_OUTPUT_DIR` emits normalized semantic output for later TypeScript comparisons.

## Updating a row

1. Add the smallest focused replacement test or retained browser artifact.
2. Add its repo-relative path and test name to the row's `replacementEvidence`.
3. Set that row to `verified`.
4. Run `node scripts/verify-parity.mjs --oracle <downloaded-oracle-directory>`.
5. Do not alter the baseline commit or fixture checksums after Swift characterization without intentionally regenerating and reviewing the oracle.
