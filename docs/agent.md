Entangle Agent runs on your machine and executes commands or hosts an interactive terminal on your behalf. It connects out to the relay server and only ever exchanges encrypted data with invokers.

**What It Does**
- Mints an ephemeral capability on each start, unless a capability URL is pinned via `--capability <url>` or `ENTANGLE_CAPABILITY` (in which case its host is used as the relay server).
- Connects to the server (`/agent/register`), receives an `agentId`, and announces capabilities.
- For each invoker connection, authenticates the session and:
  - Single command: spawns the requested process, streams stdout/stderr, sends exit status.
  - PTY: spawns a shell in a pseudo‑terminal, streams interactive I/O and resizes, forwards signals.
- Applies validation and limits: argument count/size, cwd constraints, output ceilings, and optional wall clock.

—

**How To Use**
- Install/build, then run:
  - `entangle-serve start [--server <url>] [--capability <url>] [--output-mode text|stream-json]`
  - `entangle-serve create-cap [--single-run] [--output-mode ...]`

Examples
- Start agent targeting a public relay:
  - `entangle-serve start --server https://relay.example.com`
- Create a capability (multi‑run by default) and print a shareable URL:
  - `entangle-serve create-cap`
  - Output includes `capId`, `S`, and `Web URL: https://.../cap/<capId>#S=<S>`

Output Modes
- `--output-mode text` (default): human‑friendly logs.
- `--output-mode stream-json`: structured logs for automation.

—

**Runtime Behavior**
- Heartbeat: sends `HEARTBEAT` at `AGENT_HEARTBEAT_MS` to keep registration fresh.
- Capability announcement: sends `ANNOUNCE_CAP` for each active capability (the ephemeral one it minted at start, or the pinned `--capability` URL).
- Session handling: allocates counters, derives keys on `AUTH1`, enforces `singleRun` within each session if set.
- Cleanup: aborts processes and closes PTYs on disconnect.

PTY Details
- Shell: uses `AGENT_SHELL` or `SHELL` or `/bin/bash`.
- Idle timeout: closes after `TTY_IDLE_TIMEOUT_MS` of inactivity (default 20m).
- Respects resize and sends exit frames when shell ends.
- Multiple PTY sessions can run concurrently (distinct `sessionId`).

—

**Security & Limits**
- CWD control: `AGENT_DEFAULT_CWD` is the working directory and the execution boundary (defaults to the agent's launch directory). Real‑paths are validated to mitigate traversal/symlinks. This bounds only the initial cwd, not a full filesystem sandbox.
- Arguments: checked for NULs, unpaired surrogates, count/length.
- Output ceiling: `MAX_OUT_BYTES` (default 10MB) — agent truncates and terminates the process when exceeded.
- Wall clock: `limits.wallMs` on `RUN` triggers SIGTERM → SIGKILL.
- Minimal env: child receives a reduced, safe environment.

Concurrency
- Multiple invokers can connect simultaneously for the same capability (bounded by `RELAY_BURST`). Each is isolated with independent counters and keys.

—

**Configuration (env)**
- `RELAY_URL`: default server URL (overridden by `--server`).
- `ENTANGLE_CAPABILITY`: pin a capability URL (overridden by `--capability`); its host is used as the relay server.
- `AGENT_SHELL`, `AGENT_DEFAULT_CWD`
- `MAX_OUT_BYTES`, `CMD_DEFAULT_WALL_MS`, `TTY_IDLE_TIMEOUT_MS`
- `MAX_ARG_COUNT`, `MAX_ARG_LEN`
- `LOG_LEVEL`, `OUTPUT_MODE`

—

**Internals**
- Entry: `agent/src/index.ts` (CLI), main service in `agent/src/agent.ts`.
- Sessions: `agent/src/session.ts` handles frames, auth, counters, dispatch.
- Runner: `agent/src/runner.ts` runs processes and emits encrypted `STDOUT/STDERR/EXIT`.
- PTY: `agent/src/pty.ts` manages interactive shells.
- Capability storage: `agent/src/capability.ts` creates/loads capabilities and policies.
