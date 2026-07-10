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
npm install -g @thenewlabs/entangle-serve
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

3. Start the agent. By default it binds to the directory it is launched in
   (that directory is both the working dir and the execution boundary). Set
   `AGENT_DEFAULT_CWD` to pin a different one:

```bash
AGENT_DEFAULT_CWD=/srv/my-project \
RELAY_URL=http://localhost:8080 \
entangle-serve start
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
- Relay: `npm run dev --workspace=@thenewlabs/entangle-relay`
- Serve: `npm run dev --workspace=@thenewlabs/entangle-serve`

## Security Highlights
- AEAD (XChaCha20‑Poly1305) with per‑message counters prevents replay and reordering.
- **Per‑session keys**: after the AUTH1/2/3 handshake, `K_enc`/`K_auth` are derived from the fresh handshake nonces (`nonceB`‖`nonceC`), so ciphertext captured from one session can't be replayed into another. The client verifies the echoed `nonceB` and session `expiryTs`, so a hostile/replaying relay can't spoof the agent or inject stale output.
- AAD binds each frame to its type **and direction** (no reflection of a frame back to its sender).
- HMAC handshake (AUTH1/2/3) proves knowledge of secret `S`; the optional password second factor is stored with Argon2id and verified in constant time.
- Command execution uses a **minimal environment** and an enforced **CWD allow‑list** on every exec path (command and PTY streams alike).
- Relay enforces max frame sizes, per‑IP rate limits (bounded memory), a strict CSP on the web UI, and an optional agent‑registration token; it stays blind to plaintext.

## Concurrency
- Multiple concurrent invoker sessions per capability are supported (bounded by `RELAY_BURST`).
- Each command/terminal runs as an independent multiplexed stream within a session.

## Key Env Vars
- Server: `PORT`, `HOST`, `MAX_FRAME_BYTES`, `RELAY_RATE_RPS`, `RELAY_BURST`, `CORS_ORIGINS`, `TRUST_PROXY`, `RELAY_AGENT_TOKEN`
- Agent: `RELAY_URL`, `AGENT_DEFAULT_CWD` (working dir + execution boundary; defaults to the launch directory), `AGENT_ENV_PASSTHROUGH`, `RELAY_AGENT_TOKEN`, `MAX_OUT_BYTES`

> Note: this is protocol **v2** and is not wire‑compatible with 1.0.0 — upgrade agent, relay, and connect together. The agent mints an ephemeral capability on each start unless you pin one with `--capability <url>` or `ENTANGLE_CAPABILITY` (its host is used as the relay server). Existing shared `#S=` capability URLs stay valid; password‑protected capabilities must have their password re‑set. Put the relay behind TLS and set `TRUST_PROXY=1` only when it sits behind a proxy you control.

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
- Connect CLI: `docs/connect.md`

## Testing
- `npm test` (Vitest)

---
By default the agent confines runs to the directory it was launched in (override with `AGENT_DEFAULT_CWD`). This constrains only the initial working directory — it is not a filesystem sandbox — so use OS‑level sandboxing/containers for the agent in sensitive environments.
