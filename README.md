# Entangle

Secure, blind relay to run your local CLI tools from anywhere. The server only forwards encrypted frames; your agent executes commands or hosts a live terminal. Simple, private, and auditable.

## TL;DR
- Share a capability URL to grant access temporarily.
- End‑to‑end encryption; server sees only opaque frames.
- Works for single commands or an interactive terminal (PTY).

## Quick Start
### From npm
Install the three user-facing packages after publishing:

```bash
npm install -g @thenewlabs/entangle-relay
npm install -g @thenewlabs/entangle-agent
npm install -g @thenewlabs/entangle-connect
```

### Local development
1. Install dependencies and build:

```bash
npm install
npm run build
```

2. Start the relay:

```bash
entangle-relay start
```

The default address is `http://localhost:8080`.

3. Start the agent with the directory restricted:

```bash
AGENT_ALLOWED_CWD=/srv/my-project \
AGENT_DEFAULT_CWD=/srv/my-project \
RELAY_URL=http://localhost:8080 \
entangle-agent start
```

The agent prints a capability URL like `http://localhost:8080/cap/<capId>#S=<secret>`.

4. Connect from another terminal:

```bash
entangle-connect '<cap-url>' pwd
entangle-connect '<cap-url>'
```

The first command runs one command; the second opens an interactive terminal.

### Production relay
Point `entangle.thenewlabs.com` to the relay host with DNS, then proxy HTTPS and WebSocket traffic to port `8080`. For Caddy:

```caddyfile
entangle.thenewlabs.com {
    reverse_proxy 127.0.0.1:8080
}
```

Start the relay with:

```bash
PUBLIC_ORIGIN=https://entangle.thenewlabs.com \
entangle-relay start
```

Verify it with `curl https://entangle.thenewlabs.com/__health`.

Tip: All CLIs support `--output-mode text|stream-json`.
- Server: `npm run dev --workspace=@thenewlabs/entangle-relay`
- Agent: `npm run dev --workspace=@thenewlabs/entangle-agent`

## Security Highlights
- AEAD (XChaCha20‑Poly1305) with counters prevents replay and reordering.
- HMAC handshake (AUTH1/2/3) proves knowledge of secret `S`.
- Relay enforces max frame sizes and rate limits; stays blind to plaintext.

## Concurrency
- Multiple concurrent invoker sessions per capability are supported (bounded by `RELAY_BURST`).
- `singleRun` policy restricts multiple `RUN` commands within a single session only.

## Key Env Vars
- Server: `PORT`, `HOST`, `MAX_FRAME_BYTES`, `RELAY_RATE_RPS`, `RELAY_BURST`
- Agent: `RELAY_URL`, `AGENT_ALLOWED_CWD`, `AGENT_DEFAULT_CWD`, `MAX_OUT_BYTES`

## Repo Layout
- `agent/` Agent CLI + runner + PTY
- `server/` Relay server (Express + WS)
- `invoke/` Connect CLI (single command or PTY)
- `packages/` Protocol, crypto, and utils libraries
- `web/` Optional SPA terminal client

## Learn More
- Architecture: `docs/architecture.md`
- End‑to‑end & protocol: `docs/e2e.md`
- Agent: `docs/agent.md`
- Server: `docs/server.md`
- Invoke CLI: `docs/invoke.md`

## Testing
- `npm test` (Vitest)

---
Use `AGENT_ALLOWED_CWD` to constrain where remote commands can run, and consider OS‑level sandboxing for the agent in sensitive environments.
