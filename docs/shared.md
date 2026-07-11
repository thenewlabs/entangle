Shared terminals let several people watch and drive **one** live shell together through the Entangle relay. It is the default when you launch the agent from a real terminal, and it is meant for pairing, demos, and cooperative debugging.

**What It Does**
- `entangle serve <url>` opens a single shared shell on your machine and prints a shareable session URL.
- Everyone who opens that URL **attaches to the same shell** — they see the same output and (collaboratively) can type into it. Keystrokes from the host and every viewer are merged into the one shell.
- Late joiners get a bounded **replay of recent output** on attach, so their screen syncs to the current state instead of starting blank.
- On a real terminal the host sees their shell rendered **inside a bordered session frame**:
  - Side rails (`║`) run down both edges; the shell is sized to the box interior, not the full terminal.
  - The **top border is a title bar** with the live viewer count: `╔═ ⧉ entangle · shared · N viewer(s) ═…╗`.
  - The **bottom border shows the join URL**: `╚═ https://relay/cap/<capId>#S=<secret> ═…╝`. It reads `connecting…` until the relay assigns the capability, then updates in place.
  - Shell output is parsed through a small VT emulator and repainted on a throttle so the rails and bars are never overwritten.

—

**Turning It On/Off**
- **Default**: shared mode is on when the agent is run in a real terminal — both stdin and stdout are TTYs — and the output mode is `text`. (stream-json is for programmatic invokers and never enables it.)
- `--shared`: force shared mode even when not attached to a TTY.
- `--headless`: disable shared mode. Each connection then gets its **own** shell, the previous per‑connection behavior. `--headless` wins over `--shared` if both are passed.

```bash
# Shared by default when run in a terminal
entangle serve https://relay.example.com

# Force one shared shell even without a TTY (e.g. under a supervisor)
entangle serve https://relay.example.com --shared

# Back to a private, per-connection shell for every invoker
entangle serve https://relay.example.com --headless
```

—

**Behavior While Shared**
- **One shell**: there is exactly one PTY. Its output fans out to the host and all viewers; its input is merged from the host and all viewers.
- **Host owns the size**: the shell is sized to the box interior (or the full host terminal in the raw fallback). Viewer resize requests are ignored so participants don't fight over dimensions.
- **Frame fallback**: the bordered frame requires a TTY that is at least 20 cols by 6 rows. When the host isn't a TTY, or the terminal is smaller than that, the host falls back to raw byte‑for‑byte pass‑through with no frame (and the join URL is printed as a log line instead).
- **Signals**: control characters such as Ctrl‑C travel through as raw input and reach the shell. Explicit signal frames from a viewer are ignored, so one participant can't kill the shell out from under everyone else.
- **Leaving**: when a viewer disconnects they simply detach — the shell keeps running for everyone else. The shell ends when it exits on its own (or the host leaves).
- **One-off commands still isolate**: a single command like `entangle connect <url> ls -la` (cmd mode) spawns its **own** process even while a shared terminal is active. Only interactive terminal (PTY) opens attach to the shared shell.
- Replay is bounded (256 KB of recent output by default); very old scrollback is dropped.

—

**Security**
Because the relay is **blind** — it only forwards opaque encrypted frames — anyone who holds the session URL can type into your live shell. The URL carries everything needed to attach: the capability id `capId` and secret `S` (the `#S=<secret>` fragment), plus the optional password if you set one. Treat the URL as a **live credential**, not a read-only link.

- Prefer a password as a second factor:
  - `entangle serve <url> --password` prompts for it (so it never appears in argv), or set `AGENT_PASSWORD`.
  - The password is stored with Argon2id and verified in constant time; without it, no stream can be opened.
- Share the URL over a trusted channel and revoke by stopping the agent (ephemeral capabilities die with the process).
- Remember the shell runs as your host user in `AGENT_DEFAULT_CWD` (the launch directory unless pinned); use OS‑level sandboxing/containers for sensitive environments.

For how `capId`, `S`, and the password fit into key derivation and the auth handshake, see [End‑to‑end & protocol](e2e.md) and the Security Highlights in the [README](../README.md).

—

**Internals**
- Shared PTY and replay buffer: `serve/src/shared-session.ts` (`SharedSession`).
- Host terminal wiring (status-bar vs. raw fallback, keystrokes, resize, throttled repaint): `serve/src/host-terminal.ts`.
- Session frame rendering (tmux-style blue bottom status bar with window tabs and viewer count): `serve/src/host-terminal.ts`.
- Attach path (PTY opens attach to the shared shell; cmd opens spawn normally; collaborative input, ignored viewer resizes/signals): `serve/src/multi-session.ts`.
- Shared-mode detection and flags: `serve/src/index.ts` (`start` command).
