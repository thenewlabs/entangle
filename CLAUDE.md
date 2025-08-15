# Entangle - Claude Code Memory

## Project Overview

**Entangle** is a secure blind relay system that allows exposing a single whitelisted CLI tool from a client machine to remote invokers via an encrypted relay. The relay server never sees plaintext commands, arguments, outputs, or secrets.

## Architecture

- **Agent** (`@sunpix/entangle-agent`) - Runs on machine with tool, creates capabilities, executes commands
- **Server** (`@sunpix/entangle-server`) - Blind relay that routes encrypted frames 
- **Invoke** (`@sunpix/entangle-invoke`) - CLI client for running commands remotely
- **Web** (`@sunpix/entangle-web`) - Browser-based terminal interface
- **Packages** - Shared libraries for protocol, crypto, and utilities

## Security Model

### Cryptography (No Home-Rolled Crypto)
- **AEAD**: XChaCha20-Poly1305 via `libsodium-wrappers-sumo`
- **KDF**: Argon2id (interactive params) + HKDF-SHA256 via `@noble/hashes`
- **HMAC**: HMAC-SHA256 via `@noble/hashes` 
- **Random**: `libsodium.randombytes_buf` for nonces and IDs
- **CBOR**: `cborg` for structured data encoding

### Key Guarantees
- Server is **completely blind** - never sees plaintext commands/outputs/secrets
- **Single whitelisted tool** enforcement - agent rejects other tools
- **Monotonic counters** prevent replay and reordering attacks
- **One RUN per session** by default (configurable)
- **Resource limits** (CPU, memory, wall time, output bytes)
- **Argument validation** (count, length, NUL bytes, surrogates)

### Capability Model
```
namespace: server-generated (ns_BASE32)
capId: saltCap(16B) || capRand(16B) -> base64url (routing ID)
S: 32-byte secret -> base64url (known only to invoker & agent)
```

## Wire Protocol

### Frame Format
```
byte 0:     type (AUTH1=0x01, RUN=0x10, STDOUT=0x12, etc.)
bytes 1-8:  payload length (u64 big endian)  
bytes 9+:   payload (encrypted except AUTH1/AUTH3)
```

### Auth Handshake
1. **AUTH1**: `HMAC(K_auth, "hello" || capId || nonceB)`
2. **AUTH2**: AEAD-encrypted `{ok, nonceB, nonceC, expiryTs, policyHash}`
3. **AUTH3**: `HMAC(K_auth, "ready" || nonceC)`

### Encrypted Messages
All messages except AUTH1/AUTH3 use AEAD with per-direction monotonic counters:
```
cipher = AEAD_Enc(K_enc, nonce=random24B, plaintext=CBOR({ctr, msg}), aad=CBOR({type}))
```

## Development Workflow

### Build & Run
```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Start server
npm run dev  # or cd server && npm start

# Start agent (separate terminal)
cd agent && AGENT_TOOL=/usr/bin/claude npm start

# Create capability
cd agent && npm run create-cap -- --namespace ns_ABC123

# Invoke command
cd invoke && npm start -- \
  --namespace ns_ABC123 \
  --cap-id <capId> \
  --secret-s <S> \
  --tool claude \
  --argv '["--help"]'
```

### Testing
```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run security tests
npx vitest tests/security/

# Run specific test
npx vitest packages/crypto/src/index.test.ts
```

## Configuration

### Environment Variables (.env)
```bash
# Server
PORT=8080
PUBLIC_ORIGIN=https://suncoder.dev
MAX_FRAME_BYTES=1048576
RELAY_IDLE_TIMEOUT_MS=120000

# Agent 
AGENT_TOOL=/usr/bin/claude
AGENT_ALLOWED_CWD=/home:/srv/projects
MAX_ARG_COUNT=64
MAX_ARG_LEN=4096

# Logging
LOG_LEVEL=info
```

### Agent Commands
```bash
# Start agent and register with server
entangle-agent start --tool /usr/bin/claude --server http://localhost:8080

# Create capability for current namespace
entangle-agent create-cap --namespace ns_ABC123 --single-run

# Example output:
# namespace: ns_7R6B2P
# capId: Q29e...b64url...
# S: yZJH...b64url...
# Web link: https://suncoder.dev/ns_7R6B2P/Q29e...#S=yZJH...
```

### Invoke Commands
```bash
# Run command via CLI
entangle-invoke \
  --namespace ns_7R6B2P \
  --cap-id Q29e... \
  --secret-s yZJH... \
  --tool claude \
  --argv '["project","--explain","src/index.ts"]' \
  --cwd /home/user/app \
  --abort-after-ms 5000
```

## Security Considerations

### What Server Never Sees
- Secret S or derived keys
- Plaintext commands or arguments
- Working directory paths
- Command outputs (stdout/stderr)
- Exit codes or signals

### What Server Does See
- Namespace and capId (for routing)
- Frame types and sizes (encrypted payload lengths)
- Connection timing and metadata

### Attack Prevention
- **Replay**: Monotonic counters prevent message replay
- **Tampering**: AEAD detects any ciphertext modification
- **Injection**: Argument validation prevents shell injection
- **Traversal**: CWD validation against allow-lists
- **DoS**: Resource limits prevent excessive usage
- **MITM**: End-to-end encryption prevents relay compromise

## File Structure
```
entangle/
├── packages/
│   ├── protocol/     # Wire types, frame codec
│   ├── crypto/       # AEAD, key derivation  
│   └── utils/        # Validation, logging
├── agent/            # Client agent
├── server/           # Blind relay server
├── invoke/           # Headless CLI invoker
├── web/              # React SPA terminal
└── tests/            # Comprehensive test suite
```

## Build Outputs
- `agent/dist/agent.js` → `entangle-agent` binary
- `server/dist/server.js` → `entangle-server` binary  
- `invoke/dist/invoke.js` → `entangle-invoke` binary
- `web/dist/*` → Static assets served by server

## Key Implementation Details

### Crypto Package (`packages/crypto/src/index.ts`)
- `deriveKeys(S, saltCap)` - Argon2id + HKDF key derivation
- `aeadEncrypt/Decrypt()` - XChaCha20-Poly1305 with random nonces
- `computeHmac/verifyHmac()` - HMAC-SHA256 for auth flow
- `generateCapId()` - Embedded salt + random for routing

### Agent Runner (`agent/src/runner.ts`) 
- `spawn(tool, argv, {shell: false})` - No shell interpolation
- Resource limits via process monitoring
- Environment isolation with minimal safe vars
- Output streaming with backpressure handling

### Server Routing (`server/src/state/routing.ts`)
- Namespace generation with base32 encoding
- Capability announcement and lookup
- WebSocket connection management
- Heartbeat tracking and cleanup

### Security Tests (`tests/security/`)
- Replay attack prevention with counter validation
- AEAD tampering detection
- Input validation and injection prevention
- Server blindness verification

## CLI Reference

### entangle-agent
```bash
entangle-agent start [--tool <path>] [--server <url>]
entangle-agent create-cap --namespace <ns> [--single-run]
```

### entangle-server  
```bash
entangle-server  # Starts on PORT (default 8080)
```

### entangle-invoke
```bash
entangle-invoke \
  --namespace <ns> \
  --cap-id <id> \
  --secret-s <secret> \
  --tool <tool> \
  --argv <json-array> \
  [--cwd <path>] \
  [--abort-after-ms <ms>]
```

## Troubleshooting

### Common Issues
- **Tool not found**: Ensure `AGENT_TOOL` points to executable file
- **Permission denied**: Check tool executable permissions and CWD access
- **Connection failed**: Verify server is running and network connectivity
- **Auth failed**: Ensure capId, namespace, and secret S match exactly
- **Tool mismatch**: Agent rejects tools different from configured tool

### Debug Commands
```bash
# Check server health
curl http://localhost:8080/__health

# Verbose agent logging  
LOG_LEVEL=debug entangle-agent start

# Test tool execution directly
/usr/bin/claude --help
```

### Build Issues
```bash
# Clean and rebuild
npm run clean && npm install && npm run build

# Check TypeScript compilation
npx tsc --noEmit --project packages/crypto/

# Run tests to verify functionality  
npm test
```