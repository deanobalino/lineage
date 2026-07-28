# Retained compatibility oracle

`normalized.json` is the normalized semantic output emitted by the immutable pre-cutover implementation at commit `105ef5d900a3511496f5b8a39d8ee70b1212bffa`.

It was retained from GitHub Actions run `30348227960` after the gate reported:

- `rowsTotal: 45`
- `rowsVerified: 45`
- `oraclePresent: true`
- `cutoverReady: true`
- `failures: []`

SHA-256:

```text
761e137105c1d6002d32bebf5b22be46b3445d563c238196445be640c7c470b6
```

The current Node-only compatibility job validates this contract and all source fixture checksums. Regeneration is not part of the active build because the native product and toolchain were deliberately decommissioned after the green cutover.
