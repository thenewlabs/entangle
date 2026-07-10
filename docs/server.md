The Entangle Server is a lightweight relay and static web host. It never sees plaintext commands or output; it only forwards framed, encrypted messages between invokers and agents.

**What It Does**
- Serves a health endpoint at `GET /__health`.
- Optionally serves the SPA UI from `web/dist` if present.
- Upgrades WebSocket connections and routes them:
  - `/agent/register`: agent handshake and capability announcements.
  - `/relay/:capId`: invoker connections by capability.
- Applies per‑IP WS upgrade rate limiting and frame size enforcement.
- Keeps in‑memory routing state: agents, invokers, and which agent owns a `capId`.

—

**How To Use**
- Run the server:
  - `entangle-relay [--output-mode text|stream-json]`

Health Check
- `curl http://localhost:8080/__health`
  - Returns `{ status: "ok", agents: <count> }`.

Hosting the Web UI
- If `web/dist` exists (e.g., built separately), the server serves static assets and SPA fallback for capability pages.

—

**Configuration (env)**
- Network: `PORT` (default 8080), `HOST` (default 0.0.0.0), `PUBLIC_ORIGIN` (used for links).
- Relay limits: `MAX_FRAME_BYTES` (default 1MB), `RELAY_IDLE_TIMEOUT_MS`, `RELAY_RATE_RPS`, `RELAY_BURST`.
- Logging: `LOG_LEVEL`, `OUTPUT_MODE`.

—

**Routing Model**
- Agent Registration (`/agent/register`)
  - Client sends `CLIENT_HELLO { machineId }`.
  - Server assigns `agentId` and listens for:
    - `ANNOUNCE_CAP { capId }` → maps `capId → agentId`.
    - `HEARTBEAT` updates last seen.
    - `RELAY_RESPONSE` frames → forwarded to corresponding invoker.
- Invoker Relay (`/relay/:capId`)
  - Server finds the owning agent for `capId`.
  - Assigns `invokerId`, forwards all incoming binary frames to the agent wrapped in JSON with `socketId`.
  - For idle connections exceeding `RELAY_IDLE_TIMEOUT_MS`, closes the invoker.
  - Supports multiple concurrent invokers per `capId`, bounded by `RELAY_BURST`.
- Cleanup
  - On WS close, routing state removes agents/invokers and clears capability ownerships.

—

**Security**
- Blind relay: server cannot decrypt; it only moves bytes.
- Size limits: drops oversize frames and may close connections.
- Rate limiting: per‑IP token bucket with exponential backoff for WS upgrades.
- Concurrency: per‑capability connection cap based on `RELAY_BURST`.

—

**Internals**
- Entry: `server/src/index.ts` (Express + WS upgrade handling).
- Agent route: `server/src/routes/agent.ts`.
- Relay route: `server/src/routes/relay.ts`.
- Routing state: `server/src/state/routing.ts`.
- Rate limit: `server/src/utils/rate-limit.ts`.
