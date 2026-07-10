This guide explains the end‑to‑end model that keeps the relay server blind while enabling remote execution and terminals.

**Concept**
- The agent and invoker share a capability: `{ capId, S }`.
- A short HMAC handshake proves knowledge of `S` without revealing it.
- After auth, all messages are AEAD‑encrypted with per‑message counters.
- The server only forwards opaque frames and enforces generic limits.

—

**Keys & Capabilities**
- Capability pieces:
  - `capId`: includes a salt segment (first bytes) used during key derivation.
  - `S`: random secret (base64url).
- Derivation (agent and invoker do the same):
  1) Argon2id PWHASH: `K_raw = pwhash(S, saltCap)`
  2) HKDF(SHA‑256) over `K_raw` with info `"entangle-capability"` → split into `K_enc` (32B) and `K_auth` (32B).

—

**Authentication Handshake**
1) AUTH1 (Invoker → Agent via relay)
   - Pick `nonceB` (random string/hex), compute `HMAC_Kauth("hello" + capId + nonceB)`.
   - Send payload = `HMAC || nonceB`.
2) AUTH2 (Agent → Invoker, AEAD)
   - Verify AUTH1 HMAC with derived `K_auth`.
   - Generate `nonceC` and respond with AEAD `{ ok, nonceB, nonceC, expiryTs, policyHash }`.
3) AUTH3 (Invoker → Agent)
   - Compute `HMAC_Kauth("ready" + nonceC)` and send as `AUTH3` frame payload.
4) Session authenticated.

Replay Resistance
- AUTH nonces differ each session; reusing old AUTH frames fails.
- All subsequent messages carry strictly increasing counters validated per direction.
 - Counters and auth are scoped per session; multiple sessions can run concurrently for the same capability.

—

**Frames & Encryption**
- Framing: `type (1B)` + `length (8B)` + payload.
- AEAD: XChaCha20‑Poly1305 with AAD = `{ type }`, plaintext = CBOR `{ ctr, msg }`.
- `FrameReader` accumulates bytes and yields complete frames; oversized frames are dropped.

—

**Message Families**
- Command execution:
  - `RUN` → `{ commandId, argv, cwd?, limits? }`
  - `STDOUT` / `STDERR` → `{ commandId, chunk }`
  - `EXIT` → `{ commandId, code|null, signal|null, bytesOut }`
  - `ABORT` → `{ commandId, reason? }`
  - `ERROR` → `{ commandId|null, code, detail? }` (errors are encrypted too)
- PTY (interactive terminal):
  - `TTY_OPEN` → `{ sessionId, cwd?, cols, rows }`
  - `TTY_DATA` → `{ sessionId, chunk }`
  - `TTY_RESIZE` → `{ sessionId, cols, rows }`
  - `TTY_SIGNAL` → `{ sessionId, signal }`
  - `TTY_EXIT` → `{ sessionId, code|null, signal|null }`
  - Multiple PTY sessions can be active concurrently per invoker connection (distinct `sessionId`).

—

**Validation & Limits**
- Arguments: max count/len; prohibits NULs and unpaired surrogates.
- CWD: normalize + resolve; must be within `AGENT_DEFAULT_CWD` (defaults to the agent's launch directory).
- Output ceiling: `MAX_OUT_BYTES` (default 10MB) across stdout+stderr.
- Wall clock: optional `limits.wallMs` triggers soft SIGTERM then SIGKILL.
- Frames: `MAX_FRAME_BYTES` (default 1MB) enforced at relay and in `FrameReader`.
- Rate limiting: per‑IP token bucket with exponential backoff for WS upgrades.

Session Semantics
- Multi‑session is supported at two levels:
  - Multiple invoker connections per capability (bounded by `RELAY_BURST`).
  - Multiple PTY sessions per invoker via unique `sessionId` values.
- `singleRun` is enforced per session (applies to `RUN` frames only).

—

**Threat Model Notes**
- Relay blindness: server sees only frame type and sizes; no plaintext or keys.
- Replay: prevented by per‑direction monotonic counters and fresh AUTH nonces.
- Integrity: AEAD binds ciphertext to frame type via AAD.
- Cross‑capability isolation: different `capId`/`S` derive different keys.
- Host safety: agent executes under host user; configure OS‑level sandboxing, `AGENT_DEFAULT_CWD`, and process limits as needed.

—

**Operational Checklist**
- Restrict agent’s execution context: filesystem ACLs, sandbox/container, PATH hygiene.
- Set `AGENT_DEFAULT_CWD` to pin the agent's working directory / boundary when exposing broad environments.
- Tune `RELAY_RATE_RPS` and `RELAY_BURST` for hostile networks.
- Monitor health: `GET /__health` returns basic status.
