# Security Re-audit Findings

The recent hardening changes substantially address the prior audit. The current test suite passes **213 tests across 17 files**.

## Fixed findings

- Oversized frame memory growth: `FrameReader` now discards oversized payloads incrementally and has regression tests for impossible lengths.
- Relay WebSocket payload amplification: the server now sets an explicit `maxPayload`.
- Duplicate agent registrations and unbounded per-agent capabilities: duplicate hellos are ignored and routing maps have ceilings.
- AUTH1 Argon2 amplification: one AUTH1 attempt per session and cheap payload-length checks now occur before key derivation.
- Malformed authenticated frames closing the shared agent socket: protocol errors now terminate only the affected invoker session.
- Capability secrets printed during every restart: existing capability secrets are hidden after startup.
- Full command argv logging: command logs now include only the command name and argument count.
- Malformed integer configuration: security-sensitive numeric settings now fall back to safe defaults.
- Wall-clock, output, PTY-idle timers and SIGKILL escalation: these controls are now implemented and covered by tests.

## Remaining findings

### High — CWD allow-list is not a filesystem boundary

The allow-list validates only the initial working directory ([stream-manager.ts](../agent/src/stream-manager.ts:71)). A permitted command can still execute `sh -c 'cd /etc; ...'`, use absolute paths, or launch descendants outside the configured directory. The default remains `SPAWN_SANDBOX=none` ([config.ts](../packages/utils/src/config.ts:104)).

If the directory restriction is intended as a security boundary, use an OS-level sandbox/container/chroot, filesystem permissions, or another process-isolation mechanism. Path validation alone cannot enforce it.

### High — CPU and memory limits are still not enforced

`cpuMs` and `memMB` are stored in stream limits but no enforcement path existed in the current implementation ([stream-manager.ts](../agent/src/stream-manager.ts:104)). The new wall/output controls do not prevent CPU-bound or memory-hungry processes. A resource monitor must measure the child (and preferably its process group) and terminate it when limits are exceeded.

### Medium — Partial per-stream policies can bypass defaults

`getStreamLimits()` returns early when `policy.perStream` exists ([stream-manager.ts](../agent/src/stream-manager.ts:108)). If that object omits `maxWallMs` or `maxOutBytes`, the configured defaults are not applied. Merge per-stream values over policy/global defaults instead of returning early.

### Medium — Process-tree cleanup is incomplete

SIGKILL is sent to the direct child ([stream-manager.ts](../agent/src/stream-manager.ts:453)). Shell pipelines and descendants can survive unless the process is launched in a process group and the group is terminated.

### Medium — Agent registration is still optional

The example configuration still documents `RELAY_AGENT_TOKEN` as optional ([.env.example](../.env.example:35)). Without it, arbitrary clients can register agents. Routing caps reduce memory growth but do not authenticate the control plane. Require the token by default for non-test/non-development deployments, or require an explicit opt-in for unauthenticated registration.

### Medium — Control-plane fields lack strict bounds/schema validation

`machineId`, `capId`, `socketId`, and envelope fields are accepted with minimal validation ([server/src/routes/agent.ts](../server/src/routes/agent.ts:11)). Although the WebSocket payload is capped, a message can still contain very large strings and the routing limits are configurable. Enforce bounded string lengths and the expected capability-ID format before inserting values into maps or logs.

### Low — Routing ceilings bypass config validation

`RELAY_MAX_AGENTS` and `RELAY_MAX_CAPS_PER_AGENT` are parsed directly at module load ([server/src/state/routing.ts](../server/src/state/routing.ts:26)). Invalid values such as `NaN` can disable comparisons. Parse these through the same validated configuration helper used for the other security-sensitive settings.

## Verification

- `npm test`: 17 test files, 213 tests passed.
- `git diff --check`: clean.
- The worktree contains the current hardening changes; this report does not modify source behavior.
