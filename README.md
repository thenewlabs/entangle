# Entangle

Secure, blind relay to run your local CLI tools from anywhere. The server only forwards encrypted frames; your agent executes commands or hosts a live terminal. Simple, private, and auditable.

## TL;DR
- Share a capability URL to grant access temporarily.
- End‑to‑end encryption; server sees only opaque frames.
- Works for single commands or an interactive terminal (PTY).

## Quick Start
1) Build all binaries
- `npm install` (first time)
- `npm run build` (outputs `dist/agent.js`, `dist/server.js`, `dist/invoke.js`)

2) Start the server
- `node dist/server.js` (env: `PORT=8080` by default)

3) Start the agent and create a capability
- `node dist/agent.js create-cap`
- `node dist/agent.js start --server http://localhost:8080`
  - Output will show a web URL like: `http://localhost:8080/cap/<capId>#S=<secret>`

4) Invoke (CLI)
- Interactive terminal: `node dist/invoke.js <cap-url>`
- Single command: `node dist/invoke.js <cap-url> <cmd> [args...] [--cwd PATH] [--abort-after-ms N]`

Tip: All CLIs support `--output-mode text|stream-json`.

## Minimal Usage (Dev mode)
- Server: `npm run dev --workspace=@sunpix/entangle-server`
- Agent: `npm run dev --workspace=@sunpix/entangle-agent`

## Security Highlights
- AEAD (XChaCha20‑Poly1305) with counters prevents replay and reordering.
- HMAC handshake (AUTH1/2/3) proves knowledge of secret `S`.
- Relay enforces max frame sizes and rate limits; stays blind to plaintext.

## Key Env Vars
- Server: `PORT`, `HOST`, `MAX_FRAME_BYTES`, `RELAY_RATE_RPS`, `RELAY_BURST`
- Agent: `RELAY_URL`, `AGENT_ALLOWED_CWD`, `AGENT_DEFAULT_CWD`, `MAX_OUT_BYTES`

## Repo Layout
- `agent/` Agent CLI + runner + PTY
- `server/` Relay server (Express + WS)
- `invoke/` Invoker CLI (single command or PTY)
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

