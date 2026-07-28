# Web-only cutover report

Date: 2026-07-28

Baseline: `105ef5d900a3511496f5b8a39d8ee70b1212bffa`

## Outcome

The Node/TypeScript implementation covers every row in `web-parity-matrix.json`. The replacement reads the existing `.lineage/provenance` authority without migration, serves the production React application from the authenticated host server, and keeps the isolated capture listener loopback-only.

## Automated evidence

- 28 Vitest domain, storage, provider, capture, and server tests pass.
- 9 server integration tests pass, including authentication throttling, session expiry, CSRF, Host/Origin, repository/symlink boundaries, credential rotation, body limits, and security headers.
- 9 real-browser tests pass across desktop Chromium, tablet Chromium, and touch-phone Chromium.
- Browser coverage uses real Git-backed demo and hostile-content repositories and covers Review, Explore, selected-line evidence, sessions, capture, exports, and inert rendering of repository-controlled text.
- Production capture and web bundles build from a clean Node install.
- The macOS compatibility job reconstructs the immutable Swift baseline in a detached worktree, emits the normalized oracle, validates fixture checksums, and verifies all 45 matrix rows.

## Dependency review

`react-router-dom` is pinned to the current 7.18 series. npm reports an advisory limited to React Router RSC action processing. Lineage is a client-only Vite SPA, does not enable React Server Components or React Router actions, and protects every Fastify mutation with its own same-origin session and CSRF token. The affected execution path is absent.

## Deployment boundary

- Browser: `127.0.0.1:3217`, optionally exposed to the development tailnet through HTTPS on port 9443.
- Capture: `127.0.0.1:3218`, never included in Tailscale Serve.
- Tailscale remains development transport only. Operator authentication remains mandatory.

## Cutover decision

Swift may be removed only after the retained macOS oracle artifact reports `cutoverReady: true`. The oracle source is reconstructed from immutable Git commits, so deleting the working-tree Swift product does not weaken the permanent compatibility check.
