---
title: Remote Access and Bind Model
summary: How `pnpm dev` binds ports and what a remote browser needs reachable
---

`pnpm dev` assumes the browser runs on the same machine (`http://localhost:3100`).
When it doesn't — remote laptop on Tailscale, reverse proxy, SSH tunnel — this
page documents which ports bind where and which must be reachable.

For the turn-key Tailscale flow, see
[Tailscale Private Access](/deploy/tailscale-private-access).

## Which ports bind where

Paperclip binds **two** ports in dev mode:

| Port                | Default            | Purpose                       |
| ------------------- | ------------------ | ----------------------------- |
| Main HTTP server    | `127.0.0.1:3100`   | API + UI                      |
| Vite HMR WebSocket  | `127.0.0.1:13100`  | Hot module reload (dev only)  |

Both use the same host. The host comes from `HOST`, `server.host` in the
config file, or `127.0.0.1`. The port comes from `PORT`, `server.port`, or
`3100`. The HMR port is derived: `port + 10000` (or `port - 10000` above 55535).

Neither port binds to `0.0.0.0` automatically. To reach Paperclip from another
machine, use a bind preset (`pnpm dev --bind lan` or `--bind tailnet`), or set
`HOST` to the interface you want and run `paperclipai allowed-hostname` for the
hostname the browser uses.

## What the browser needs reachable

- **Main port** (`3100`): always.
- **HMR port** (`13100`): only for hot-reload. The app works without it.

Without HMR the console shows a connection error, but the UI still works —
file edits won't hot-reload, so refresh manually.

## Known limitations

### Reverse proxy, SSH tunnel, or Tailscale Serve

If Paperclip sits behind a reverse proxy (e.g. Tailscale Serve proxying
`https://<host>.ts.net:8100` → `http://127.0.0.1:3100`), only the main port
is proxied by default. HMR will look broken in the console because the HMR
WebSocket URL (`ws://<bind-host>:13100`) is unreachable from outside.

To restore hot-reload, forward both ports: `3100` and `13100` (or
`server.port + 10000`). If you don't need hot-reload, the console error is
cosmetic.

### Hostname guard in private deployments

When `deploymentMode` is `local_trusted` or `authenticated` and
`deploymentExposure` is `private` (default for `pnpm dev`), Paperclip enforces
a hostname allowlist. Requests with a `Host` header that isn't the bind host,
a loopback name, or an entry in `server.allowedHostnames` get `403`:

```
Hostname '<host>' is not allowed for this Paperclip instance.
If you want to allow this hostname, please run pnpm paperclipai allowed-hostname <host>
```

Add the hostname and restart:

```sh
pnpm paperclipai allowed-hostname my-host.tailnet.ts.net
```

See [Tailscale Private Access](/deploy/tailscale-private-access) for details.
