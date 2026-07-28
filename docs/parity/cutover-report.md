# Web-only cutover report

Date: 2026-07-28

Baseline: `105ef5d900a3511496f5b8a39d8ee70b1212bffa`

## Outcome

The Node/TypeScript implementation covers every row in `web-parity-matrix.json`. The replacement reads the existing `.lineage/provenance` authority without migration, serves the production React application from the authenticated host server, and keeps the isolated capture listener loopback-only.

## Automated evidence

- 29 Vitest domain, storage, provider, capture, and server tests pass.
- 9 server integration tests pass, including authentication throttling, session expiry, CSRF, Host/Origin, repository/symlink boundaries, credential rotation, body limits, and security headers.
- 9 real-browser tests pass across desktop Chromium, tablet Chromium, and touch-phone Chromium.
- Browser coverage uses real Git-backed demo and hostile-content repositories and covers Review, Explore, selected-line evidence, sessions, capture, exports, and inert rendering of repository-controlled text.
- Production capture and web bundles build from a clean Node install.
- The immutable baseline oracle is retained in `docs/parity/oracle/normalized.json`; the Node compatibility gate validates its contract, fixture checksums, and all 45 matrix rows.

## Dependency review

`react-router-dom` is pinned to the current 7.18 series. npm reports an advisory limited to React Router RSC action processing. Lineage is a client-only Vite SPA, does not enable React Server Components or React Router actions, and protects every Fastify mutation with its own same-origin session and CSRF token. The affected execution path is absent.

## Deployment boundary

- Browser: `127.0.0.1:3217`, optionally exposed to the development tailnet through HTTPS on port 9443.
- Capture: `127.0.0.1:3218`, never included in Tailscale Serve.
- Tailscale remains development transport only. Operator authentication remains mandatory.

## Cutover decision

GitHub Actions run `30348227960` reported `cutoverReady: true`, `oraclePresent: true`, 45 of 45 rows verified, and no failures. The retained normalized oracle has SHA-256 `761e137105c1d6002d32bebf5b22be46b3445d563c238196445be640c7c470b6`.

The one-time native oracle gate is complete. Its normalized output is now a permanent repository fixture, so deleting the legacy product also removes the native CI/toolchain dependency without weakening the compatibility check.
