# Entangle - Claude Code Memory

## Project Overview

**Entangle** is a secure blind relay system that allows exposing CLI tools and terminal sessions from a client machine to remote invokers via an encrypted relay. The relay server never sees plaintext commands, arguments, outputs, or secrets.

The system supports two modes:
1. **Command Execution Mode**: Run specific commands with arguments
2. **Terminal Mode**: Interactive PTY (pseudo-terminal) sessions for full shell access

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
- **Monotonic counters** prevent replay and reordering attacks
- **Single-run mode** (default) - one command per session
- **Multi-run mode** (optional) - multiple commands per session
- **Resource limits** (CPU, memory, wall time, output bytes)
- **Argument validation** (count, length, NUL bytes, surrogates)
- **PTY session support** with idle timeout and signal forwarding

### Capability Model
```
namespace: server-generated (ns_BASE32)
capId: saltCap(16B) || capRand(16B) -> base64url (routing ID)
S: 32-byte secret -> base64url (known only to invoker & agent)
```

## Wire Protocol

### Frame Format
```
byte 0:     type (see frame types below)
bytes 1-8:  payload length (u64 big endian)  
bytes 9+:   payload (encrypted except AUTH1/AUTH3)
```

### Frame Types
```
0x01 AUTH1      // Authentication handshake
0x02 AUTH2      
0x03 AUTH3
0x10 RUN        // Execute command
0x11 STDIN      // Input stream
0x12 STDOUT     // Output stream
0x13 STDERR     // Error stream
0x14 EXIT       // Process exit
0x15 ERROR      // Error message
0x16 ABORT      // Abort execution
0x17 KEEPALIVE  // Keep connection alive
0x20 TTY_OPEN   // Initialize PTY session
0x21 TTY_DATA   // Bidirectional terminal data
0x22 TTY_RESIZE // Terminal resize event
0x23 TTY_SIGNAL // Send signal to PTY
0x24 TTY_EXIT   // PTY process exit
```

### Auth Handshake
1. **AUTH1**: Payload = `HMAC(K_auth, "hello" || capId || nonceB)` || `nonceB`
   - First 32 bytes: HMAC
   - Remaining bytes: nonceB (as UTF-8 string)
2. **AUTH2**: AEAD-encrypted `{ok, nonceB, nonceC, expiryTs, policyHash}`
3. **AUTH3**: `HMAC(K_auth, "ready" || nonceC)`

### Encrypted Messages
All messages except AUTH1/AUTH3 use AEAD with per-direction monotonic counters:
```
cipher = AEAD_Enc(K_enc, nonce=random24B, plaintext=CBOR({ctr, msg}), aad=CBOR({type}))
```

## Usage Modes

### Command Execution Mode
Run specific commands with arguments:
```bash
# Execute a command
entangle-invoke \
  --namespace ns_ABC123 \
  --cap-id xKZa3b_7Q... \
  --secret-s 9Hj2_xPmL... \
  --argv '["claude","--help"]' \
  --cwd /home/user
```

### Terminal Mode
Interactive PTY session (when no argv provided):
```bash
# Start interactive terminal
entangle-invoke \
  --namespace ns_ABC123 \
  --cap-id xKZa3b_7Q... \
  --secret-s 9Hj2_xPmL... \
  --cwd /home/user \
  --cols 120 \
  --rows 40
```

### Simplified URL Format
```bash
# Using URL format
entangle-invoke https://suncoder.dev/cap/capId#S=secret claude --help
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
cd agent && npm start

# Create capability
cd agent && npm run create-cap -- --namespace ns_ABC123

# Invoke command
cd invoke && npm start -- \
  --namespace ns_ABC123 \
  --cap-id <capId> \
  --secret-s <S> \
  --argv '["claude","--help"]'

# Or start interactive terminal
cd invoke && npm start -- \
  --namespace ns_ABC123 \
  --cap-id <capId> \
  --secret-s <S>
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
RELAY_RATE_RPS=10
RELAY_BURST=50

# Agent 
AGENT_ALLOWED_CWD=/home:/srv/projects
MAX_ARG_COUNT=64
MAX_ARG_LEN=4096
AGENT_SHELL=/bin/bash
TTY_IDLE_TIMEOUT_MS=1200000

# Logging
LOG_LEVEL=info
OUTPUT_MODE=text
```

### Agent Commands
```bash
# Start agent
entangle-agent start [--server http://localhost:8080]

# Create capability (single-run mode)
entangle-agent create-cap --namespace ns_ABC123 --single-run

# Create capability (multi-run mode, default)
entangle-agent create-cap --namespace ns_ABC123

# Example output:
# namespace: ns_7R6B2P
# capId: Q29e...b64url...
# S: yZJH...b64url...
# Web link: https://suncoder.dev/ns_7R6B2P/Q29e...#S=yZJH...
```

### Invoke Commands
```bash
# Command execution mode
entangle-invoke \
  --namespace ns_7R6B2P \
  --cap-id Q29e... \
  --secret-s yZJH... \
  --argv '["claude","project","--explain","src/index.ts"]' \
  --cwd /home/user/app \
  --abort-after-ms 5000 \
  --output-mode text

# Terminal mode (no argv)
entangle-invoke \
  --namespace ns_7R6B2P \
  --cap-id Q29e... \
  --secret-s yZJH... \
  --cwd /home/user/app \
  --cols 120 \
  --rows 40

# URL format
entangle-invoke https://suncoder.dev/cap/capId#S=secret claude --help
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

## PTY (Terminal) Features

### Browser Terminal
- Full xterm.js integration with resize support
- Copy/paste functionality
- Signal forwarding (Ctrl+C, Ctrl+D, etc.)
- Automatic reconnection on disconnect
- CWD selection dialog before session start

### CLI Terminal
- Raw terminal mode for proper input handling
- Dynamic terminal resizing
- Signal forwarding to remote process
- Seamless interactive experience

### PTY Security
- Session isolation with unique IDs
- Idle timeout (default 20 minutes)
- Minimal environment variables
- No shell interpolation
- Signal validation

## Key Implementation Details

### Crypto Package (`packages/crypto/src/index.ts`)
- `deriveKeys(S, saltCap)` - Argon2id + HKDF key derivation
- `aeadEncrypt/Decrypt()` - XChaCha20-Poly1305 with random nonces
- `computeHmac/verifyHmac()` - HMAC-SHA256 for auth flow
- `generateCapId()` - Embedded salt + random for routing

### Agent Runner (`agent/src/runner.ts`) 
- `spawn(argv[0], argv.slice(1), {shell: false})` - No shell interpolation
- Resource limits via process monitoring
- Environment isolation with minimal safe vars
- Output streaming with backpressure handling

### PTY Manager (`agent/src/pty.ts`)
- Session management with unique IDs
- Terminal resizing support
- Signal forwarding (SIGINT, SIGTERM, etc.)
- Idle session cleanup (default 20 minutes)
- Full bidirectional data streaming

### Server Routing (`server/src/state/routing.ts`)
- Namespace generation with base32 encoding
- Capability announcement and lookup
- WebSocket connection management
- Heartbeat tracking and cleanup

### Rate Limiting (`server/src/utils/rate-limit.ts`)
- Token bucket algorithm with configurable burst and rate
- Exponential backoff for repeated violations
- Per-IP rate limiting with X-Forwarded-For support

### Security Tests (`tests/security/`)
- Replay attack prevention with counter validation
- AEAD tampering detection
- Input validation and injection prevention
- Server blindness verification

## CLI Reference

### entangle-agent
```bash
entangle-agent start [--server <url>]
entangle-agent create-cap --namespace <ns> [--single-run]
```

### entangle-server  
```bash
entangle-server  # Starts on PORT (default 8080)
```

### entangle-invoke
```bash
# Command mode
entangle-invoke \
  --namespace <ns> \
  --cap-id <id> \
  --secret-s <secret> \
  --argv <json-array> \
  [--cwd <path>] \
  [--abort-after-ms <ms>] \
  [--output-mode text|stream-json]

# Terminal mode
entangle-invoke \
  --namespace <ns> \
  --cap-id <id> \
  --secret-s <secret> \
  [--cwd <path>] \
  [--cols <n>] \
  [--rows <n>]

# URL format
entangle-invoke <url> [command args...]
```

## Troubleshooting

### Common Issues
- **Command not found**: Ensure command exists and is executable
- **Permission denied**: Check command executable permissions and CWD access
- **Connection failed**: Verify server is running and network connectivity
- **Auth failed**: Ensure capId, namespace, and secret S match exactly
- **PTY session timeout**: Idle sessions are cleaned up after TTY_IDLE_TIMEOUT_MS

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