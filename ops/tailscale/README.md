# Tailscale development access

Lineage remains bound to `127.0.0.1:3217`. The isolated capture listener remains bound to `127.0.0.1:3218` and must never be proxied.

On the current development VPS, expose only the browser listener:

```bash
tailscale serve --bg --https=9443 http://127.0.0.1:3217
```

The resulting tailnet-only URL is:

```text
https://vmi3069815.tail816f62.ts.net:9443
```

This is a development route for the team. Tailscale is not an end-user dependency and does not replace Lineage operator authentication.
