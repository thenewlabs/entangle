Entangle lets you run your local CLI tools from anywhere, safely. Share a one‑time link (a “capability URL”) and a remote client can execute a command or open a live terminal on your machine. The relay server never sees your secrets or commands — everything is end‑to‑end encrypted between the invoker and your agent.

**What This Is**
- A minimal “blind relay” for CLI access: the server routes encrypted frames only.
- A local agent that executes commands and streams results back.
- A simple protocol with authenticated setup, counters for replay protection, and PTY support for interactive terminals.

**Why It Matters**
- Privacy: the server is blind to commands, output, and working directory.
- Control: you decide which machine runs the agent and what’s allowed.
- Simplicity: small, auditable code and a clear protocol.

**How It Works (High Level)**
- You create a capability (capId + secret S). Share the URL containing both.
- The invoker connects to the server’s relay endpoint with `capId` and proves knowledge of `S` using a short HMAC handshake.
- After auth, both sides exchange encrypted frames (AEAD). The server only forwards bytes.
- For single commands: the agent spawns the process and streams stdout/stderr until exit.
- For terminals (PTY): a shell runs under a pseudo‑terminal with real‑time input/output and resize handling.

**Core Components**
- `agent`: connects to the server, announces capabilities, executes runs or PTY sessions.
- `server`: Express + WebSocket upgrade; relays binary frames between invokers and agents; includes health check and static web hosting.
- `invoke`: a CLI to use capability URLs from terminals (single command or interactive PTY).
- `web`: a browser UI that performs the same protocol for PTY.
- `packages/protocol`: message types, frame encoding, constants.
- `packages/crypto`: key derivation (Argon2id + HKDF), AEAD (XChaCha20-Poly1305), HMAC.
- `packages/utils`: logging/output formatting, config/env, argument/CWD validation, counters.

—

**Protocol Overview**
- Frames: `type (1 byte)` + `length (8 bytes, big‑endian)` + `payload`.
- Types: `AUTH1/2/3`, `RUN`, `STDIN/STDOUT/STDERR/EXIT/ERROR/ABORT/KEEPALIVE`, PTY: `TTY_OPEN/DATA/RESIZE/SIGNAL/EXIT`.
- Limits: frames are capped (`MAX_FRAME_BYTES`, default 1MB) and dropped if oversize.

Authentication
- Capability: `{ capId, S }`. `capId` embeds a random salt fragment; `S` is a random secret.
- Keys: derive per capability using Argon2id → HKDF: results in `K_enc` (AEAD) and `K_auth` (HMAC).
- Handshake:
  1) Invoker → Agent via relay: AUTH1 payload = `HMAC_Kauth("hello" + capId + nonceB) || nonceB`.
  2) Agent verifies HMAC, replies AUTH2 (AEAD): `{ ok, nonceB, nonceC, expiryTs, policyHash }`.
  3) Invoker sends AUTH3 = `HMAC_Kauth("ready" + nonceC)`. Session is authenticated.
- Replay protection: each encrypted message carries a strictly increasing counter validated per direction.

Encryption
- All post‑auth messages use XChaCha20‑Poly1305 AEAD with:
  - AAD = `{ type }` (binds cipher to frame type)
  - PT = `{ ctr, msg }` encoded with CBOR
- The server never sees plaintext.

Commands vs PTY
- Single command (`RUN`): arguments, optional `cwd`, optional limits (`wallMs`, etc.). Agent enforces argument length/count and bytes‑out ceilings.
- Terminal (`TTY_*`): opens shell in validated `cwd`, streams bidirectional bytes and supports resize/signals.

—

**Server Architecture**
- HTTP: `GET /__health` returns `{ status: "ok", agents }`.
- Static web (optional): serves `web/dist` when present.
- WebSocket upgrades:
  - `/agent/register`: agents register, get an `agentId`, announce capabilities, and receive invoker connection events.
  - `/relay/:capId`: invokers connect by capability; server finds the agent that owns it and forwards frames.
- Routing state (`server/src/state/routing.ts`):
  - Maps `agentId → { ws, machineId, capabilities, lastHeartbeat }`.
  - Maps `capId → agentId` and `invokerId → { ws, capId }`.
  - Basic concurrency guard per capability using `RELAY_BURST`.
- Rate limiting (`server/src/utils/rate-limit.ts`): per‑IP token bucket with exponential backoff for WS upgrades.

Security at the Relay
- The relay enforces max frame size and closes abusive connections.
- It never decrypts: it forwards raw frames in a small JSON envelope to the agent, which unwraps and processes.

—

**Agent Architecture**
- Startup: load capabilities from `~/.entangle/capabilities.json` (0600), connect to server, heartbeat, announce all caps.
- On invoker connect: create a session object with counters and derived keys after auth; handle frames via `FrameReader`.
- Command runner: spawns process with minimized env; streams stdout/stderr; enforces `bytesOut` ceilings; supports abort and `wallMs` kill.
- PTY manager: spawns a shell under a pseudo‑terminal; streams output; reacts to resize and signals; closes idle sessions.
- Policy: currently supports `singleRun`; hashed into AUTH2 for the invoker to verify.

Validation & Limits
- Arguments: max count/length, forbid NULs and unpaired surrogates.
- CWD: optional allowed directory prefixes; resolves realpath to prevent traversal/symlinks.
- Output: `MAX_OUT_BYTES` ceiling (default 10MB) per command.
- Time: default/overrides via env; per‑message counters enforce ordering and prevent replay.

—

**CLI & Binaries**
- Agent: `entangle-agent`
- Server: `entangle-server`
- Invoke: `entangle-invoke`

Run From Source
- Dev: `npm run dev --workspace=@sunpix/entangle-server` (server), `npm run dev --workspace=@sunpix/entangle-agent` (agent).
- Build: `npm run build` creates bundled binaries in `dist/` (`agent.js`, `server.js`, `invoke.js`).

Key Environment Variables (see `packages/utils/src/config.ts`)
- `PORT`, `HOST`, `PUBLIC_ORIGIN`, `RELAY_URL` (agent/invoke default target), `MAX_FRAME_BYTES`, `RELAY_IDLE_TIMEOUT_MS`,
  `AGENT_HEARTBEAT_MS`, `CMD_DEFAULT_WALL_MS`, `TTY_IDLE_TIMEOUT_MS`, `MAX_OUT_BYTES`, `LOG_LEVEL`, `RELAY_RATE_RPS`, `RELAY_BURST`,
  `AGENT_SHELL`, `AGENT_DEFAULT_CWD`, `AGENT_ALLOWED_CWD`, `SPAWN_SANDBOX`, `MAX_ARG_COUNT`, `MAX_ARG_LEN`.

Operational Notes
- The server is intentionally blind; apply OS‑level sandboxing where appropriate for the agent.
- Use `AGENT_ALLOWED_CWD` to constrain where commands/PTY can run.
- Tune `RELAY_RATE_RPS` and `RELAY_BURST` to protect the relay in hostile environments.

