# Entangle — Developer Specification

## Overview

Entangle exposes a **single whitelisted CLI tool** from a client machine to remote invokers via a blind relay. The relay only routes ciphertext, never sees secrets, commands, outputs, or cwd. Namespaces are created by the server. Invokers can use the browser SPA or a headless CLI. The non-browser CLI accepts **namespace**, **capId** (includes salt), and **S** (secret) as arguments. No URLs required.

### Components

* `./agent` — client agent that runs on the machine offering the tool
* `./server` — relay and static site server for the SPA (reverse proxy terminates TLS)
* `./invoke` — headless CLI invoker for automation
* `./web` — browser SPA for interactive use
* `./packages/*` — shared protocol, crypto, and utilities

All build to separate outputs, share code via workspaces.

---

## Security & Threat Model (short)

* Server only learns routing metadata (namespace, capId). It never learns S, commands, args, outputs, or cwd.
* Messages are end-to-end AEAD encrypted. Replay and reordering are blocked with monotonic counters.
* Capability strictly binds to one tool. The agent enforces that only that tool can run and that **exactly one RUN** is allowed per session by default. No argument can be appended by the server because the relay never sees plaintext and the agent validates the AEAD with counters.
* If the relay is compromised, attackers cannot run commands without S. They can only block or delay traffic.
* The agent runs the tool with least privilege and no shell interpolation.

---

## Monorepo Layout

Use `pnpm` workspaces and TypeScript across the board.

```
entangle/
  .env
  package.json                 # name: "entangle", private: true, workspaces
  pnpm-workspace.yaml
  tsconfig.base.json
  packages/
    protocol/                  # wire types, frame codec, constants (TS)
    crypto/                    # key derivation and AEAD wrappers
    utils/                     # shared helpers, logging, validation
  agent/
    src/
      index.ts                 # main
      capability.ts            # cap generation, store
      runner.ts                # spawn, sandbox, limits, abort
      relay.ts                 # agent<->server control and data pipes
      policy.ts                # argument and cwd policy checks
      auth.ts                  # AUTH1/2/3
    tsconfig.json
    package.json               # name: "@entangle/agent"
  server/
    src/
      index.ts                 # http + ws
      routes/
        relay.ts               # relay WS handlers
        agent.ts               # agent register and announce
      state/
        routing.ts             # {namespace, capId} -> sockets
        heartbeat.ts
      web.ts                   # serve ./web build
    tsconfig.json
    package.json               # name: "@entangle/server"
  invoke/
    src/
      index.ts                 # CLI entry
      run.ts                   # connect, auth, run, stream, abort
    tsconfig.json
    package.json               # name: "@entangle/invoke"
  web/
    src/
      main.ts                  # SPA bootstrap
      App.tsx
      api/relay.ts             # WS wrapper
      views/Invoke.tsx         # form and terminal
    vite.config.ts
    tsconfig.json
    package.json               # name: "@entangle/web"
```

### Build outputs

* `agent/dist/agent.js` (bin: `entangle-agent`)
* `server/dist/server.js` (bin: `entangle-server`)
* `invoke/dist/invoke.js` (bin: `entangle-invoke`)
* `web/dist/*` static assets

---

## Environment Configuration

Root `.env` (loaded by all packages via `dotenv`):

```
# Reverse proxy terminates TLS. Server listens HTTP on this port.
PORT=8080
PUBLIC_ORIGIN=https://suncoder.dev

# Sizing and limits
MAX_FRAME_BYTES=1048576
RELAY_IDLE_TIMEOUT_MS=120000
AGENT_HEARTBEAT_MS=15000
MAX_CONCURRENT_RUNS_PER_CAP=1

# Logging
LOG_LEVEL=info

# SPA
SPA_BASE_PATH=/

# Optional: IP based coarse rate limits (relay only)
RELAY_RATE_RPS=10
RELAY_BURST=50
```

Each subproject can add overrides with its own `.env` if needed.

---

## Capability Model

* **namespace** — created by server on agent registration, unique string
* **capId** — routing identifier visible to server, includes `saltCap`
* **S** — 32-byte secret known only to the invoker and agent

### capId structure

Embed salt in capId to avoid query params. Use base64url without padding.

```
saltCap: 16 bytes random
capRand: 16 bytes random
capId = b64url( saltCap || capRand )   # 32 raw bytes → 43 or 44 chars
```

Server can read capId to route. Invoker and agent extract first 16 bytes as `saltCap`.

### Key derivation

```
K_raw  = Argon2id(input = S, salt = saltCap, opslimit=interactive, memlimit=64-128MB)
K_enc, K_auth = HKDF(K_raw, info="entangle-capability", length=64) split into 2x32B
AEAD = XChaCha20-Poly1305 (libsodium)
HMAC = HMAC-SHA256
```

### Session binding

* One capability session allows **one RUN** by default. After EXIT, session closes.
* Optionally, agent can mark a capability as multi-use or time-boxed, configurable by a policy flag.

---

## Wire Protocol

Transport: WebSocket per session

* Browser SPA and CLI connect to: `ws://<server>/relay/{namespace}/{capId}`
* Server glues this invoker socket to the owning agent control socket (already registered). It does not parse frames beyond a 1-byte type and 8-byte length.

### Frame format (outer)

All data payloads are opaque to the server.

```
byte 0      : type (u8)
bytes 1..8  : payload length (u64 big endian)
bytes 9..N  : payload (binary)
```

Types:

```
0x01 AUTH1
0x02 AUTH2
0x03 AUTH3
0x10 RUN
0x11 STDIN
0x12 STDOUT
0x13 STDERR
0x14 EXIT
0x15 ERROR
0x16 ABORT
0x17 KEEPALIVE
```

### Encrypted payloads

All application messages except AUTH1 and AUTH3 use AEAD. Maintain a **per direction** counter `ctr` starting at 0. Each encrypted record is:

```
cipher = AEAD_Enc( key=K_enc,
                   nonce = XChaCha20 24 bytes (random per record),
                   plaintext = CBOR({ ctr, msg }),
                   aad = CBOR({ type }) )
```

Reject messages if:

* `ctr` is not strictly greater than last seen in that direction
* AEAD decrypt fails
* type is not allowed in the current state

Use CBOR for compactness and strict types.

### Auth handshake

* **AUTH1** (invoker → agent): raw payload is `HMAC(K_auth, "hello" || capId || nonceB)`
* **AUTH2** (agent → invoker): AEAD payload with plaintext:

  ```
  { ok: true, nonceB, nonceC, expiryTs, policyHash }
  ```
* **AUTH3** (invoker → agent): raw payload is `HMAC(K_auth, "ready" || nonceC)`

If any step fails, agent closes the socket.

---

## Messages (plaintext schemas inside AEAD)

Use CBOR but shown here in TS style.

```ts
type RunMsg = {
  ctr: number
  msg: {
    commandId: string
    tool: string             // must equal the whitelisted tool
    argv: string[]           // free form, length caps apply
    cwd?: string             // optional
    limits?: {
      cpuMs?: number         // cap by policy
      memMB?: number         // cap by policy
      wallMs?: number        // cap by policy
      maxOutBytes?: number   // cap by policy
    }
  }
}

type StdoutMsg = { ctr: number, msg: { commandId: string, chunk: bytes } }
type StderrMsg = { ctr: number, msg: { commandId: string, chunk: bytes } }

type ExitMsg = {
  ctr: number
  msg: { commandId: string, code: number|null, signal: string|null, bytesOut: number }
}

type ErrorMsg = { ctr: number, msg: { commandId: string|null, code: string, detail?: string } }

type AbortMsg = { ctr: number, msg: { commandId: string, reason?: string } }

type KeepaliveMsg = { ctr: number, msg: { t: number } }
```

---

## Server Responsibilities

* Generate `namespace` on agent registration (cryptographically random, base32, short).
* Maintain in-memory routing:

  ```
  namespace -> { agentSocket, machineId, announcedCaps: Set<capId>, lastHeartbeat }
  (namespace, capId) -> agentSocket
  ```
* Rate limit at connection level only. Do not inspect payloads.
* Provide WebSocket endpoints:

  * `ws /agent/register` for agents
  * `ws /relay/{namespace}/{capId}` for invokers
* Serve SPA at `/` from `./web/dist`
* Heartbeats and cleanup of dead sockets

The server never stores secrets or plaintext.

---

## Agent Responsibilities

* Discover and validate the whitelisted tool path (no symlinks outside allowed dirs, executable bit set).
* Register with server to receive a unique `namespace`.
* Create capabilities locally:

  * Generate capId (with embedded saltCap) and store local policy
  * Announce capId to the server for routing
  * Output a shareable capability tuple `{ namespace, capId, S }` and optional SPA link
* Enforce policy at runtime:

  * Tool name must match the single allowed tool
  * Use `execFile` or `spawn` with `shell: false`
  * Apply cwd rules
  * Apply resource limits (see below)
  * Single RUN per session unless configured otherwise
* Abort mapping:

  * On ABORT, send SIGTERM then SIGKILL after grace period

### Policy and validation

* Allowed tool: exactly one, set at agent startup via flags or `.env`
* Arguments: “anything” allowed, but length and count are capped to prevent abuse

  * `MAX_ARG_COUNT` default 64
  * `MAX_ARG_LEN` default 4096 bytes each
  * Reject NUL and unpaired surrogates
* CWD:

  * Optional; default is agent working dir
  * Allow list of base dirs via `.env` (`AGENT_ALLOWED_CWD=/home:/srv/projects`)
  * Resolve realpath and ensure it is within allow list
* Output caps:

  * `maxOutBytes` enforced with backpressure and hard cut
* Limits enforcement:

  * Linux: `cgroups` v2 for CPU quota, memory limit, and pids
  * macOS: `taskpolicy` and `ulimit` as a fallback
  * Windows: Job Objects

### Privilege separation

* Run spawned processes as a dedicated unprivileged user (documented in README)
* Optional `bubblewrap`/`chroot` sandbox per spawn on Linux if available
* No inherited environment except a minimal safe set; pass through only what is needed

---

## Invoke CLI (non-browser)

### Usage

```
entangle-invoke \
  --namespace ns_abcd123 \
  --cap-id AbCdEF...b64url... \
  --secret-s S_base64url... \
  --tool claude \
  --cwd /home/lennard/app \
  --argv '["project","--explain","src/index.ts"]' \
  [--abort-after-ms 5000] \
  [--max-out-bytes 1048576]
```

Notes

* There is no URL. The CLI takes `namespace`, `capId`, and `S` directly.
* The CLI derives keys from `S` and saltCap extracted from capId.
* The CLI performs the exact same AUTH1/2/3 and AEAD flow as the SPA.
* The CLI writes STDOUT and STDERR to the terminal, exits with the remote exit code.

### Argument safety

* `--tool` must match the tool in policy. CLI does not allow alternate tools.
* The argv is a JSON array of strings. CLI does not expand shell globs.
* The agent enforces the same constraints again, so the relay cannot append or mutate args.

---

## SPA (browser) behavior

* On first load, SPA reads fragment `#S=...` and path `{namespace}/{capId}` if invoked via link generator
* Derives keys client side and establishes WS to `/relay/{namespace}/{capId}`
* Renders a simple terminal that streams output
* Provides a CWD field and an Abort button
* SPA never sends S to the server. The fragment is parsed entirely client side.

---

## Example End-to-End Flow

1. **Agent start**

```
PUBLIC_ORIGIN=https://suncoder.dev AGENT_TOOL=/usr/bin/claude pnpm --filter @entangle/agent start
```

* Agent registers to `ws /agent/register`
* Server responds with `namespace = ns_7R6B2P`

2. **Agent creates capability**

```
$ entangle-agent create-cap
namespace: ns_7R6B2P
capId: Q29e...b64url...(saltCap||capRand)
S: yZJH...b64url...
tool: claude
policy: maxCpuMs=60000, maxMemMB=512, singleRun=true
```

Agent announces cap to the server for routing.

3. **Invoker runs from CLI**

```
entangle-invoke \
  --namespace ns_7R6B2P \
  --cap-id Q29e... \
  --secret-s yZJH... \
  --tool claude \
  --cwd /home/lennard/app \
  --argv '["project","--explain","src/index.ts"]' \
  --abort-after-ms 5000
```

4. **Handshake**

* AUTH1: invoker → agent (relay forwards)
* AUTH2: agent → invoker (AEAD)
* AUTH3: invoker → agent

5. **Run**

* Invoker sends RUN (AEAD)
* Agent validates tool, argv, cwd, limits
* Agent spawns `/usr/bin/claude project --explain src/index.ts` in cwd
* Streams STDOUT/ERR back in AEAD frames

6. **Abort**

* At 5 seconds, CLI sends ABORT
* Agent sends SIGTERM, then SIGKILL after 2 seconds if needed
* Agent returns EXIT with `signal="SIGTERM"`

---

## Relay Implementation Details

* `ws /agent/register`:

  * Receive `{ type: "CLIENT_HELLO", machineId, tools:[string] }`
  * Create `namespace` as `ns_` + base32(random 10 bytes)
  * Store `{ agentSocket, machineId }`
  * Respond `{ type: "ASSIGN", namespace }`
* `ws /relay/{namespace}/{capId}`:

  * Find agent for namespace and capId in announced set
  * If missing, close with 404 close code
  * Start piping frames both ways with backpressure handling
  * Idle timeout based on `.env`

Backpressure: pause reading on one socket when the other write buffer exceeds a threshold, resume on drain.

---

## CLI and Agent Binaries

* `entangle-agent`:

  * `start` — run agent, register, fetch namespace
  * `create-cap` — create capability for current policy, print tuple
  * Flags: `--tool /usr/bin/claude`, `--policy-file ./policy.json`, `--single-run true|false`

* `entangle-invoke`:

  * Arguments as above
  * Exit with remote exit code

* `entangle-server`:

  * Serves `web/dist` at `/`
  * Provides WS endpoints
  * Health check at `/__health`

---

## Resource Limits (reference)

Linux cgroups v2

* Create a transient cgroup per command under `entangle.slice/cap_<capId>/cmd_<commandId>`
* Enforce:

  * `cpu.max = <quota> <period>`
  * `memory.max = <bytes>`
  * `pids.max = 128`
* Kill on exceed and report `ERROR { code: "resource_exceeded" }`

macOS fallback

* `ulimit -t`, `ulimit -m`, and a wall timer
* Consider `sandbox-exec` profile if available

Windows

* Job Object with CPU rate control and memory limit

---

## Logging and Observability

* Structured logs (pino) at agent and server
* Server never logs payloads
* Agent logs: commandId, start, exit code or signal, bytesOut, duration
* Optional signed local audit log (agent signs a CBOR record with Ed25519 key stored locally). Not required by default.

---

## Error Codes

`ERROR.code` values:

* `auth_failed`
* `tool_not_allowed`
* `arg_limit_exceeded`
* `cwd_not_allowed`
* `resource_exceeded`
* `multi_run_not_allowed`
* `unknown_command_id`
* `internal_error`

All errors are AEAD protected and include `commandId` when applicable.

---

## Testing Strategy

* Unit tests for crypto and frame codec in `packages/*`
* Agent spawn tests with a fake tool that echoes args and cwd
* E2E tests:

  * Spin up server on ephemeral port
  * Start agent, create cap
  * Run invoke, assert output, abort handling
  * Simulate relay drop and reconnection

Use `vitest` and `tsx` for fast runs.

---

## Tooling

* TypeScript strict mode
* ESLint with security rules
* Zod for schema validation at boundaries
* `libsodium-wrappers-sumo` for XChaCha20-Poly1305 and random bytes
* `cborg` for CBOR
* `ws` for WebSocket
* `pino` for logs
* `dotenv` for env

---

## Developer Notes and Guarantees

* The relay can never add or modify arguments. It never has plaintext and the agent rejects messages with invalid counters or AEAD tags.
* Only the single whitelisted tool can run. The agent hard checks `tool` equals policy and uses `execFile` with `shell: false`.
* Only one RUN per session unless policy enables multi-run.
* The non-browser CLI takes raw `namespace`, `capId`, and `S` so it can be scripted easily.
* Salt is inside capId, not transported separately.
* Entangle runs behind a reverse proxy. The proxy terminates TLS and sets `X-Forwarded-*`. The server respects `PUBLIC_ORIGIN` for SPA absolute links but otherwise only binds to `PORT`.

---

## Minimal Code Sketches

### packages/crypto

```ts
import sodium from "libsodium-wrappers-sumo";

export async function deriveKeys(S: Uint8Array, saltCap: Uint8Array) {
  await sodium.ready;
  const K_raw = sodium.crypto_pwhash(
    32, S, saltCap,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
  const hk = sodium.crypto_kdf_keygen(); // use HKDF via HMAC-SHA256
  const prk = sodium.crypto_auth_hmacsha256(K_raw, new Uint8Array(0));
  const K_enc = hdkfExpand(prk, "entangle-capability-enc", 32);
  const K_auth = hdkfExpand(prk, "entangle-capability-auth", 32);
  return { K_enc, K_auth };
}

export function aeadEnc(K_enc: Uint8Array, type: number, ctr: bigint, plaintext: Uint8Array) {
  const nonce = sodium.randombytes_buf(24);
  const aad = cborEncode({ type });
  const pt = cborEncode({ ctr, msg: plaintext });
  const cipher = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(pt, aad, null, nonce, K_enc);
  return { nonce, cipher };
}

export function aeadDec(K_enc: Uint8Array, type: number, nonce: Uint8Array, cipher: Uint8Array) {
  const aad = cborEncode({ type });
  const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, cipher, aad, nonce, K_enc);
  const { ctr, msg } = cborDecode(pt);
  return { ctr: BigInt(ctr), plaintext: msg as Uint8Array };
}
```

### agent policy enforcement (spawn)

```ts
spawn(toolPath, argv, {
  cwd,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
  env: minimalEnv,
  uid: sandboxUid, gid: sandboxGid
});
```
100%. No home-rolled crypto. We only compose well-reviewed primitives from vetted libraries and keep our own code at the “glue” layer.

Here is the concrete plan your devs should follow:

## Crypto libraries to use

* AEAD: `libsodium-wrappers-sumo` XChaCha20-Poly1305
* KDF for secret S: Argon2id via `libsodium` `crypto_pwhash` (interactive params), or `argon2` package if you prefer a dedicated lib
* HKDF: Node `crypto` `hkdf` or `@noble/hashes/hkdf` on top of HMAC-SHA256
* HMAC: Node `crypto` `createHmac` or `@noble/hashes/hmac` with SHA-256
* CBOR: `cborg`
* Randomness: `libsodium.randombytes_buf` for nonces and IDs

Pin versions in `package.json`:

```json
{
  "dependencies": {
    "libsodium-wrappers-sumo": "^0.7.13",
    "@noble/hashes": "^1.5.0",
    "cborg": "^4.2.6",
    "ws": "^8.17.1",
    "zod": "^3.23.8",
    "pino": "^9.3.2",
    "dotenv": "^16.4.5"
  }
}
```

## Safe defaults and guardrails

* Never implement ciphers, MACs, padding, or nonce handling yourself. Use AEAD APIs directly.
* XChaCha20-Poly1305 with random 24-byte nonces per record is safe against nonce reuse as long as randomness is strong.
* Per-direction monotonically increasing counters live in plaintext inside the AEAD payload to stop replay and reordering.
* Derive keys as:

  1. `K_raw = crypto_pwhash(32, S, saltCap, INTERACTIVE)` from libsodium
  2. `K_enc` and `K_auth` via HKDF-SHA256 `info="entangle-capability"`
* HMAC inputs are exact byte concatenations. Use fixed ASCII labels like `hello` and `ready`.
* Zero out key material in memory when sessions close if feasible.

## Code patterns

* Treat everything as `Uint8Array` at crypto boundaries. Encode JSON or CBOR to bytes before encrypting.
* Strict input validation with `zod` before any cryptographic operation or spawn.
* Use Node streams backpressure. Never buffer unbounded outputs in memory.

## Example glue code (short)

```ts
import sodium from "libsodium-wrappers-sumo";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

export async function derive(S: Uint8Array, saltCap: Uint8Array) {
  await sodium.ready;
  const Kraw = sodium.crypto_pwhash(
    32, S, saltCap,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
  const prk = hkdf(sha256, Kraw, /*salt*/ new Uint8Array(0), new TextEncoder().encode("entangle-capability"), 64);
  const K_enc = prk.slice(0, 32);
  const K_auth = prk.slice(32, 64);
  return { K_enc, K_auth };
}

export function aeadSeal(K_enc: Uint8Array, type: number, ctr: bigint, msg: Uint8Array) {
  const nonce = sodium.randombytes_buf(24);
  const aad = cborEncode({ type });
  const pt  = cborEncode({ ctr: ctr.toString(), msg }); // keep it canonical
  const cipher = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(pt, aad, null, nonce, K_enc);
  return { nonce, cipher };
}

export function aeadOpen(K_enc: Uint8Array, type: number, nonce: Uint8Array, cipher: Uint8Array) {
  const aad = cborEncode({ type });
  const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, cipher, aad, nonce, K_enc);
  const { ctr, msg } = cborDecode(pt);
  return { ctr: BigInt(ctr), msg: msg as Uint8Array };
}
```

## Operational checklist

* Secrets only in memory. No logging, no metrics with payload, no crash dumps containing keys.
* Use strong RNG only. Do not use `Math.random`.
* Secure headers on the web app and never reflect the fragment `#S` anywhere.
* Threat model tests:

  * Replay test: record frames then try to replay out of order → must fail.
  * Relay compromise test: connect without AUTH or with wrong HMAC → must fail.
  * Arg mutation test: man-in-the-middle changes argv bytes → AEAD must fail.
* Containers run as non-root; spawned tool under a dedicated user with limited privileges.
* Resource control: cgroups v2 on Linux, Job Objects on Windows, ulimit on macOS.
