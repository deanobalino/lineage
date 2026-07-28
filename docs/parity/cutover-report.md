# Web-only cutover report

Date: 2026-07-28

Baseline: `105ef5d900a3511496f5b8a39d8ee70b1212bffa`

## Outcome

The Node/TypeScript implementation covers every row in `web-parity-matrix.json`. The replacement reads the existing `.lineage/provenance` authority without migration, serves the production React application from the authenticated host server, and keeps the isolated capture listener loopback-only.

## Automated evidence

- 52 Vitest domain, storage, provider, capture, and server tests pass.
- 17 server and capture integration tests pass, including authentication throttling, session expiry, CSRF, Host/Origin, repository/symlink boundaries, credential rotation, body limits, capture health transitions, replay durability, diagnostics, and security headers.
- 15 real-browser tests pass across desktop Chromium, tablet Chromium, and touch-phone Chromium.
- Browser coverage uses real Git-backed demo and hostile-content repositories and covers Review, Explore, selected-line evidence, sessions, capture, exports, and inert rendering of repository-controlled text.
- Production capture and web bundles build from a clean Node install.
- The immutable baseline oracle is retained in `docs/parity/oracle/normalized.json`; the Node compatibility gate validates fixture checksums, exact named replacement tests, all 45 matrix rows, and current Node output against the oracle's events, sessions, graph, evidence, Markdown, JSON, Agent Trace, redaction, hook lifecycle, and counts.

## Dependency review

`react-router-dom` is pinned to the current 7.18 series. npm reports an advisory limited to React Router RSC action processing. Lineage is a client-only Vite SPA, does not enable React Server Components or React Router actions, and protects every Fastify mutation with its own same-origin session and CSRF token. The affected execution path is absent.

## Deployment boundary

- Browser: `127.0.0.1:3217`, optionally exposed to the development tailnet through HTTPS on port 9443.
- Capture: `127.0.0.1:3218`, never included in Tailscale Serve.
- Tailscale remains development transport only. Operator authentication remains mandatory.

## Cutover decision

The local and pull-request cutover gates require `cutoverReady: true`, `oraclePresent: true`, `oracleCompared: true`, 45 of 45 rows verified, every semantic oracle section matched, and no failures. The retained normalized oracle has SHA-256 `761e137105c1d6002d32bebf5b22be46b3445d563c238196445be640c7c470b6`.

The one-time native oracle gate is complete. Its normalized output is now a permanent repository fixture, so deleting the legacy product also removes the native CI/toolchain dependency without weakening the compatibility check.
