# Entangle

Secure blind relay for exposing CLI tools. The relay never sees plaintext commands, arguments, outputs, or secrets.

## Quick Start

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Start server (in one terminal)
npm run server

# Start agent with single tool (in another terminal)
AGENT_TOOL=/usr/bin/claude npm run agent

# Or start agent with multiple tools (creates single multi-tool capability)
npm run agent -- --tool /usr/bin/claude --tool /usr/bin/git

# Create capability for specific tool (with single-run option)
npm run agent:create-cap -- --namespace ns_ABC123 --tool /usr/bin/claude --single-run

# Invoke from CLI
npm run invoke -- \
  --namespace ns_ABC123 \
  --cap-id <capId> \
  --secret-s <S> \
  --tool claude \
  --argv '["--help"]'
```

## Architecture

- **Agent**: Runs on the machine with the tool, creates capabilities, executes commands
- **Server**: Blind relay that routes encrypted frames between agents and invokers
- **Invoke**: CLI client for running commands remotely
- **Web**: Browser-based terminal for interactive use

## Security

- End-to-end AEAD encryption (XChaCha20-Poly1305)
- Argon2id key derivation from secret S
- Monotonic counters prevent replay attacks
- Server never sees plaintext
- Whitelisted tools enforcement (supports multiple tools per agent)
- Resource limits and sandboxing

## Development

```bash
# Run server in dev mode
npm run dev

# Run tests
npm test

# Clean build artifacts
npm run clean
```

## Configuration

Environment variables in `.env`:

- `PORT`: Server port (default: 8080)
- `PUBLIC_ORIGIN`: Public URL for link generation
- `AGENT_TOOL`: Path to tool to expose
- `AGENT_ALLOWED_CWD`: Colon-separated allowed directories
- `MAX_ARG_COUNT`: Maximum number of arguments
- `MAX_ARG_LEN`: Maximum argument length