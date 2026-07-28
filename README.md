# Lineage

**Every line has a story.**

Lineage is a local-first, self-hosted web application for reviewing AI coding provenance. It reads the `.lineage/provenance` data already stored inside Git repositories, links provider evidence to commits and line ranges, and answers the practical question: why does this line exist?

The browser is a client of a local Node server. It never reads Git or the filesystem directly. Repository paths stay on the host, browser routes use opaque repository IDs, and capture arrives through a separate loopback-only listener.

Lineage records provider-visible prompts, tool activity, permission and user decisions, external constraints, diffs, tests, final messages, and Git evidence. It does not claim to capture private model reasoning.

## Requirements

- Node.js 22.15 or newer
- Git
- A local repository under an operator-approved root
- Chromium only for the browser test suite

Tailscale is optional development transport. It is not required by Lineage or by end users.

## Run locally

Install and build:

```bash
npm ci
npm run build
```

Start the production server:

```bash
LINEAGE_ALLOWED_ROOTS=/path/you/allow npm start
```

On first start, Lineage creates its state directory with owner-only permissions and prints a one-time operator token. Open `http://127.0.0.1:3217`, enter that token, then choose **Open repository**. The registry stores the canonical local path in a mode-0600 file so the repository remains available on later visits without another import.

For source development:

```bash
npm run dev
```

The Node server serves the built production UI from `dist/web`. Run `npm run build:web` after frontend changes, or use `npm run dev:web` for the standalone Vite development server.

## Product workflows

**Review** is the primary workspace. It compares the checked-out branch with a selected local or remote base, shows status-grouped files, real hunks, per-line provenance markers, branch commits, and adjacent evidence. On tablet and phone the same workspace becomes focused file, diff, and evidence views with URL-backed selection and browser Back support.

**Explore** is repository archaeology. Browse the source tree, select a line, and inspect provider evidence or Git-only history.

The web app also includes:

- repository open, forget, unavailable-state recovery, and demo reset
- local and remote branch selection
- provider-first explanations with explicit Git-only fallback
- sessions, transcript evidence, and follow-up prompts
- capture installation, activity, queue, replay, degraded state, and dead letters
- Markdown and Agent Trace exports
- responsive access to every action on desktop, tablet, and phone

## Capture

Build the capture entry point with the application:

```bash
npm run build:capture
```

The output is `dist/lineage-capture.mjs`. It accepts provider hook JSON on stdin and supports Codex and GitHub Copilot CLI hook installation without replacing unrelated configuration.

Capture is durable before network delivery:

1. validate and bound the provider input
2. persist an envelope by temporary write, flush, and atomic rename
3. attempt a short request to the isolated loopback listener
4. always let hook mode exit successfully within one second
5. replay pending records through leases, quotas, retries, and dead letters

Delivery is at least once and server ingestion is idempotent by the capture ingestion ID. Storage or quota failure remains fail-open for the provider but is reported as degraded health; Lineage never claims unsaved evidence was captured.

Useful explicit commands fail closed:

```bash
node dist/lineage-capture.mjs --doctor /path/to/repo
node dist/lineage-capture.mjs --link /path/to/repo
node dist/lineage-capture.mjs --verify-line /path/to/repo src/file.ts marker
node dist/lineage-capture.mjs --recover-codex /path/to/repo
```

Hook mode and administrative commands share the same TypeScript domain services as the host server.

## Data compatibility

Existing data remains authoritative and requires no migration:

```text
.lineage/provenance/events.jsonl
.lineage/provenance/sessions/*.json
```

Readers tolerate legacy missing fields, malformed JSONL records, and unknown provider payloads. New writes retain the established snake-case JSONL/session formats, stable graph and Agent Trace hashes, redaction rules, line expansion limits, and deterministic ordering.

The cutover contract lives in:

- `docs/parity/web-parity-matrix.json`
- `tests/fixtures/compatibility/manifest.json`
- `.github/workflows/compatibility-oracle.yml`

The pre-cutover implementation was run once at the immutable baseline commit and its normalized semantic oracle is retained at `docs/parity/oracle/normalized.json`. CI verifies that artifact, fixture checksums, and all 45 parity rows on Node/Linux. There is no native toolchain, build, CI, or runtime dependency in the current product.

## Self-hosting and Tailscale development

The default listeners are:

```text
Browser: 127.0.0.1:3217
Capture: 127.0.0.1:3218
```

Only the browser listener may be placed behind a TLS reverse proxy. The capture listener must stay loopback-only.

This repository includes a user service at `ops/systemd/lineage.service`. The current development VPS exposes only the authenticated browser app to its tailnet:

```bash
tailscale serve --bg --https=9443 http://127.0.0.1:3217
```

See `ops/tailscale/README.md` for the development boundary. For an internet-facing deployment, configure a real TLS reverse proxy, explicit `LINEAGE_ALLOWED_HOSTS` and `LINEAGE_ALLOWED_ORIGINS`, a narrow `LINEAGE_ALLOWED_ROOTS`, and an independent backup policy for both Lineage state and repository provenance.

## Security model

- random bootstrap credentials are displayed once; only verifier digests are stored server-side
- operator sessions are short-lived, server-side, revocable, `HttpOnly`, and `SameSite=Strict`
- state and secret files use owner-only permissions
- mutations require same-origin checks and CSRF tokens
- Host and Origin allowlists protect reverse-proxied access
- login attempts are throttled and request bodies are bounded
- Git commands use fixed executable arguments plus time and output caps
- repository-controlled text is rendered as inert text under a restrictive CSP
- sensitive responses are `no-store`

Forgetting a repository removes registry state only. It never deletes `.lineage/provenance` or repository files.

## Architecture

```text
Codex / GitHub Copilot CLI hooks
            |
            v
durable capture outbox ----> loopback capture listener :3218
                                      |
                                      v
                           .lineage/provenance
                                      |
                                      v
browser :3217 <---- authenticated Fastify API ----> bounded Git adapter
      |
      +---- Review / Explore / Sessions / Capture / Exports
```

The boundary between browser, host services, capture, and the compatibility domain is ordinary HTTP and TypeScript. This leaves room for a future centrally hosted mode without changing the local provenance format.

## Quality gates

```bash
npm run typecheck
npm test
npm run test:integration
npm run build
npm run test:browser
```

The browser suite exercises real Git-backed repositories across desktop, tablet, and touch-phone Chromium projects, including hostile source, diff, and commit text.
