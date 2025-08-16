# Entangle

Secure blind relay system with full POSIX terminal support. The relay never sees plaintext commands, arguments, outputs, or secrets.

## Features

- **Interactive Terminal**: Full POSIX terminal over encrypted WebSocket
- **Single Command Mode**: Run individual commands with streaming output
- **End-to-End Encryption**: Server acts as blind relay, never sees plaintext
- **Browser & CLI**: Both web terminal and command-line interfaces
- **No User Switching**: Commands run as the same OS user as the agent

## Quick Start

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Start server (in one terminal)
npm run server

# Start agent (in another terminal)
npm run agent

# Agent will display:
# capId: <base64url>
# S: <base64url>
# Web URL: https://suncoder.dev/cap/<capId>#S=<S>

# Use the web URL in browser for interactive terminal
# Or use invoke CLI:

# Interactive terminal
npm run invoke -- https://suncoder.dev/cap/<capId>#S=<S>

# Single command
npm run invoke -- https://suncoder.dev/cap/<capId>#S=<S> ls -la
```

## Architecture

- **Agent**: Runs on target machine, handles PTY/command execution
- **Server**: Blind relay that routes encrypted frames by capId
- **Invoke**: CLI supporting both terminal and single command modes
- **Web**: Browser terminal (xterm.js) and single command UI

## Security

- **Encryption**: XChaCha20-Poly1305 AEAD
- **Key Derivation**: Argon2id + HKDF from secret S
- **Anti-Replay**: Monotonic counters per direction
- **Blind Server**: Only sees capId for routing, not content
- **CWD Validation**: Optional allowed directory restrictions

## Configuration

Environment variables in `.env`:

```bash
# Server
PORT=8080
PUBLIC_ORIGIN=https://suncoder.dev

# Timeouts
TTY_IDLE_TIMEOUT_MS=1200000    # 20 minutes
CMD_DEFAULT_WALL_MS=60000       # 1 minute

# Agent
AGENT_SHELL=/bin/bash
AGENT_DEFAULT_CWD=$HOME
AGENT_ALLOWED_CWD=/home:/Users:/srv
```

## Development

```bash
# Run server in dev mode
npm run dev

# Run tests
npm test

# Clean build artifacts
npm run clean
```

## URL Format

```
https://suncoder.dev/cap/{capId}#S={secret}
```

- `capId`: Base64url encoded (32 bytes: 16 salt + 16 random)
- `S`: Base64url encoded 32-byte secret in fragment (never sent to server)