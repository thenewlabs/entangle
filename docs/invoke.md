`entangle-connect` is a small CLI that consumes a capability URL to execute a single command or open an interactive terminal through the Entangle relay.

**What It Does**
- Parses a capability URL like `https://relay.example.com/cap/<capId>#S=<secret>`.
- Derives keys from `<capId>` and `<secret>`.
- Authenticates to the agent through the relay and runs either:
  - Single command: streams stdout/stderr and exits with the remote code.
  - Terminal: opens a PTY session and proxies keyboard/resize/signals.

—

**Usage**
- Show help (no args):
  - Prints version and usage examples.
- Terminal mode:
  - `entangle-connect <cap-url> [--cwd PATH] [--cols N] [--rows N] [--output-mode text|stream-json]`
  - With no trailing args after the URL, an interactive shell opens.
- Single command mode:
  - `entangle-connect <cap-url> <cmd> [args...] [--cwd PATH] [--abort-after-ms N] [--output-mode ...]`
  - Exits with the remote command’s exit code.

Examples
- Open an interactive shell:
  - `entangle-connect https://relay.example.com/cap/capId#S=secret`
- Run a command with a working directory and timeout:
  - `entangle-connect https://relay.example.com/cap/capId#S=secret ls -la --cwd /srv/app --abort-after-ms 30000`

Output Modes
- `--output-mode text` (default): human‑readable.
- `--output-mode stream-json`: structured for programmatic consumption.

—

**How It Works (Protocol)**
- Extracts `capId` and `S` from the URL.
- Chooses `ws://` or `wss://` based on URL scheme.
- Performs AUTH1/2/3 with HMACs using derived `K_auth`.
- Sends AEAD frames with `{ ctr, msg }` bound to frame `type` via AAD.
- Validates incoming counters and writes chunks to stdout/stderr or TTY.

—

**Notes & Tips**
- `--cwd` is validated by the agent; it may be rejected if outside `AGENT_DEFAULT_CWD` (the agent's working directory / boundary).
- `--abort-after-ms` for single commands maps to `limits.wallMs` on the agent.
- Ctrl+C in terminal mode sends `SIGINT` to the remote PTY session.
 - You can open multiple PTY sessions by re‑invoking with the same capability URL; each is independent.

—

**Internals**
- Entry: `invoke/src/index.ts` (argument parsing and mode selection).
- Single command: `invoke/src/single.ts`.
- Terminal: `invoke/src/terminal.ts`.
- Uses `FrameReader`, crypto from `@thenewlabs/entangle-crypto`, and utilities from `@thenewlabs/entangle-utils`.
