# Lineage

**Every line has a story.**

Git blame tells you who. Lineage tells you why.

Lineage is a local-first macOS app for AI coding provenance. Codex and GitHub Copilot CLI are supported coding harnesses. Harness support is plugin-based so Claude Code, Cursor, and other coding agents can be added without creating a second provenance pipeline. Lineage captures provider evidence, links it to Git commits and line ranges, and lets an engineer ask: "Why does this line of code exist?"

Lineage does not claim to capture private model reasoning. It records prompts, tool calls/results, permission or approval events when providers expose them, diffs, tests, final assistant messages, and Git evidence.

## Run locally

```bash
swift run Lineage
```

The welcome screen offers:

- **Open Repository** for any local Git repository.
- **Open Demo Repository** for a generated demo repo with real commits and recorded Codex provenance.

Inside a repository, Lineage has two modes:

- **Review**: local branch/MR-style review. Compare the current branch against a selected base branch and ask why changed files/hunks exist.
- **Explore**: line-level incident/history archaeology. Click a line and inspect why that existing line exists.

## Build a macOS app bundle

```bash
Scripts/build-macos-app.sh
open dist/Lineage.app
```

The bundle includes both `Lineage` and `lineage-capture` in `Contents/MacOS`, so **Install Codex Capture** can write a stable absolute collector path for a demo repository.

## Capture CLI

Build the local capture command:

```bash
swift build --product lineage-capture
```

The executable reads provider hook JSON from stdin, maps it into Lineage's canonical event schema, and appends structured events to:

```text
.lineage/provenance/events.jsonl
```

On `Stop`, it also runs the session linker and writes durable summaries to:

```text
.lineage/provenance/sessions/*.json
```

Example:

```bash
echo '{"hook_event_name":"UserPromptSubmit","session_id":"codex-demo","payload":{"prompt":"Fix retry policy"}}' | swift run lineage-capture
```

Diagnostics:

```bash
lineage-capture --doctor /path/to/repo
lineage-capture --link /path/to/repo
lineage-capture --verify-line /path/to/repo packages/shared/src/learning.ts someLineMarker
```

`--doctor` proves the collector can resolve and write to the repository. `--link` rebuilds session summaries after a change has been committed, which is also what Lineage runs during refresh. `--verify-line` exercises the same explanation engine as the app and fails if the selected line has no matched provider provenance.

Canonical events include:

- `provider`
- `provider_event_name`
- `event_type`
- `actor`
- `human`
- `session_id`
- `turn_id`
- `repo_root`
- `cwd`
- `payload`

Provider-specific details remain in `payload` so adapters can preserve source evidence without forcing every provider into the same raw shape.

Decision-oriented canonical event types include:

- `assistant_options_presented`
- `user_decision`
- `permission_decision`
- `external_constraint`

When a provider exposes prompted human decisions, Lineage stores the actual selected option text, all presented alternatives, and freeform responses when the human writes something different. Permission decisions are recorded only when the provider exposes the decision/status.

External constraints can be captured as provider-agnostic evidence with:

- file path
- line or range when known
- excerpt or summary
- whether it came from a tool read or was inferred from provider/diff context

The right pane renders this as an ADR-like decision record: context, decision, alternatives considered, external constraints, evidence, and consequences/risk when available.

## Coding harness capture

The capture controls in the bottom-left sidebar install either or both coding-harness plugins. Configurations coexist, so different engineers—or different sessions in the same codebase—can use Codex, Copilot CLI, or both while events remain attributed to the correct harness.

**Codex** creates:

```text
.lineage/provenance/
.codex/config.toml
```

The generated config follows the requested Codex hook shape for:

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `PermissionRequest`
- `Stop`

If the hook schema changes in Codex, keep the same command target and update the TOML matcher shape in `Sources/LineageCore/HookConfig.swift`.

**GitHub Copilot CLI** creates:

```text
.lineage/provenance/
.github/hooks/lineage-copilot.json
```

The generated JSON uses Copilot CLI's repository hook format and captures `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Stop`, and `SessionEnd`. Every hook sets `LINEAGE_PROVIDER=github-copilot` and its own `LINEAGE_HOOK_EVENT`, which keeps Copilot events separate from Codex events and preserves the lifecycle event when Copilot sends a native camelCase payload without an event-name field. Copilot CLI reloads hook changes when the CLI starts, so reinstall capture and restart Copilot CLI after upgrading Lineage. See GitHub's [Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference).

## Provider adapters

Provider support lives behind `ProvenanceProviderAdapter`.

Current harness plugins:

- `CodexHarnessPlugin` / `CodexProviderAdapter`
- `GitHubCopilotCLIHarnessPlugin` / `GitHubCopilotProviderAdapter`

Adapter responsibilities:

- identify the provider, for example `codex`
- map native provider event names into canonical `event_type` values
- preserve raw provider evidence in `payload`
- normalize prompt, tool, command, approval, prompted decision, external constraint, final-message, diff, test, and changed-file fields where the provider supplies them

To add another coding harness, implement `CodingHarnessPlugin` and its `ProvenanceProviderAdapter`, then register the plugin in `CodingHarnessPluginRegistry`. The shared installer, configured-harness status, collector routing, session linker, and right-pane evidence UI then use the plugin automatically.

## Demo your own repository

1. Launch Lineage:

   ```bash
   swift run Lineage
   ```

2. Click **Open Repository** and choose your repo.
3. In **Capture setup** at the bottom-left, install Codex capture, Copilot CLI capture, or both. Lineage builds or finds `lineage-capture`, copies it to `~/.lineage/bin/lineage-capture`, creates `.lineage/provenance/`, writes each harness's config, and runs a local collector self-check.
4. Use a configured harness in that repo and make a change. Restart Copilot CLI after installing its hooks. If a harness prompts you to trust hooks, approve them; Lineage's **Capture activity** status confirms whether events have actually been written.
5. Return to Lineage and click **Refresh**. Lineage reloads Git state, links captured events into `.lineage/provenance/sessions/*.json`, and updates line badges/explanations.

Repository loading, branch switching, refresh, and line explanations run off the main UI thread so large repos should remain responsive.

## Review a branch locally

Use **Review** mode for the main reviewer workflow.

Lineage compares the current branch to a selectable base branch. The default base prefers `origin/main`, `main`, `upstream/main`, `origin/master`, or `master` when present. It uses local Git state only:

```bash
git merge-base <base> HEAD
git diff --name-status <base>...HEAD
git diff <base>...HEAD
git log --oneline <merge-base>..HEAD
```

Review mode shows:

- changed files grouped by status: added, modified, deleted, renamed
- summary metrics: files changed, commits on branch, provider sessions linked, files with recorded provenance, files inferred from Git only
- hunk-oriented diffs with old/new line numbers
- provider-first change explanations in the right pane

If provider provenance maps to a changed file, Lineage shows the prompt, decisions, external constraints, tests, final message, and provider evidence first. If no provider evidence matches, it says the review explanation is inferred from local Git only.

No remote MR/PR API integration is used yet. Local branch review approximates MR review from your checked-out Git state. The model includes branch commit data so commit-level review can be added next.

## Architecture

```text
AI coding harness plugins (Codex, Copilot CLI, ...)
        ↓
lineage-capture local command
        ↓
provider adapter
        ↓
.lineage/provenance/events.jsonl
        ↓
session summariser / linker
        ↓
.lineage/provenance/sessions/*.json
        ↓
git commit + line-range mapping
        ↓
Lineage macOS app
        ↓
"Why does this line exist?"
```

Captured provider provenance is treated as the source of truth. Git is supporting evidence for commits, blame, diffs, and line mapping. Harness-specific events share one canonical schema while preserving their native payload and provider identity.

The primary product workflow is code review: understanding why a branch's changes exist before merging. The secondary workflow is incident archaeology: understanding why an existing line remains in the codebase.
