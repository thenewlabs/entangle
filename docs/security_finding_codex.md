# Security Findings

Audit target: `main` worktree (`security-hardening` branch).

No source files were changed during the audit.

## Findings

### High — Pre-authentication memory exhaustion in frame parsing

[`FrameReader`](../packages/protocol/src/frame.ts:35) buffers an oversized frame until its entire declared 64-bit length arrives. The relay only limits each WebSocket message, not the declared frame length ([relay.ts](../server/src/routes/relay.ts:43)). A client knowing an active `capId`—but not `S` or the password—can grow agent memory indefinitely.

A bounded proof of concept declared a `UINT64_MAX` payload and supplied one 1 MiB chunk; the reader retained all 1,048,576 bytes while waiting for the impossible payload length.

Recommended mitigation: reject and close immediately when the header exceeds the configured limit, or discard oversized payloads incrementally without buffering them.

### High — Relay control plane is vulnerable to message and memory denial of service

The WebSocket server relies on the installed `ws` default 100 MiB payload limit ([index.ts](../server/src/index.ts:115)). Agent messages are fully buffered and synchronously parsed before token checking, with no message-rate or schema limits ([agent.ts](../server/src/routes/agent.ts:11)).

With registration authentication disabled—the checked-in configuration does not set `RELAY_AGENT_TOKEN`—one connection can repeatedly register agents and announce unlimited capabilities into unbounded maps ([routing.ts](../server/src/state/routing.ts:31)).

Recommended mitigation: set explicit payload limits, validate message envelopes, allow one registration per socket, cap agents/capabilities, and require the registration token in non-development deployments.

### High — Documented execution resource limits are not enforced

`CMD_DEFAULT_WALL_MS`, `TTY_IDLE_TIMEOUT_MS`, `MAX_OUT_BYTES`, CPU, memory, and `SPAWN_SANDBOX` are configured but mostly unused ([config.ts](../packages/utils/src/config.ts:59)). New capabilities contain only `singleRun` and `maxStreams` ([capability.ts](../agent/src/capability.ts:26)), so the output ceiling is normally absent, and no CPU, memory, wall-clock, or PTY idle enforcement exists.

SIGKILL escalation is also ineffective: the fallback checks `childProcess.killed`, which becomes true when SIGTERM is sent rather than when the process exits ([stream-manager.ts](../agent/src/stream-manager.ts:395)). Resistant processes are therefore not killed.

This enables host resource exhaustion by a capability holder. Recommended mitigation: apply defaults to every stream, enforce wall/output/CPU/memory/idle limits, use process groups or a sandbox, and kill based on exit state rather than `killed`.

### High — AUTH1 permits Argon2 work amplification

Every AUTH1 performs Argon2 key derivation before checking minimum payload length or HMAC ([session.ts](../agent/src/session.ts:167]). Authentication frames are not limited to one attempt, and agent frame handlers are launched without awaiting or serializing them ([agent.ts](../agent/src/agent.ts:122]).

Anyone knowing `capId` can queue expensive authentication work without knowing `S`.

Recommended mitigation: permit one AUTH1 per session, require an exact nonce size, serialize authentication processing, and add authentication/message rate limits.

### Medium — Malformed authenticated traffic disconnects the entire agent

Decrypted messages are cast to TypeScript types rather than checked with the existing Zod schemas ([multi-session.ts](../agent/src/multi-session.ts:338)). Counter mismatches or protocol errors close `session.ws`, which is the shared agent-to-relay control connection, taking down every capability and invoker ([multi-session.ts](../agent/src/multi-session.ts:346)).

Recommended mitigation: validate decoded messages with bounded schemas and terminate only the affected invoker session.

### Medium — Remote-execution credentials and command arguments are logged

Every agent startup prints stored capability secrets and complete capability URLs ([agent.ts](../agent/src/agent.ts:207]); executed argv is also logged verbatim ([stream-manager.ts](../agent/src/stream-manager.ts:307]).

In systemd, container, or centralized logs, this exposes remote-shell credentials and command-line secrets.

Recommended mitigation: show `S` only during explicit creation/retrieval and redact command arguments and sensitive values from logs.

### Low — Environment file and configuration hardening

`.env` is tracked while only `.env.local` is ignored ([.gitignore](../.gitignore:1)). It currently contains no detected secrets, but it should become `.env.example` before registration tokens or passwords are added.

Configuration integers are parsed without range validation ([config.ts](../packages/utils/src/config.ts:53)); malformed values can disable or distort limits. Validate all security-sensitive settings at startup and fail closed.

## Positive controls observed

- Random capability material and Argon2id password hashing.
- Direction-bound AEAD and replay counters.
- `shell: false` for command execution.
- Minimal child environment with an explicit passthrough allow-list.
- Realpath-aware CWD validation.
- Capability-file permissions of `0700`/`0600`.
- CSP, `nosniff`, and `no-referrer` headers on the web UI.

## Verification

- All 16 test files and 200 tests passed.
- Common secret-signature scanning found no embedded private keys or common token formats.
- Offline npm audit reported zero advisories across 296 dependencies. This is cache-limited; a live audit was not run because it would disclose private lockfile metadata externally.
- The worktree remained unchanged apart from this report file.
