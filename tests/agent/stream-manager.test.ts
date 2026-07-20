import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { StreamManager } from '../../serve/src/stream-manager.js';
import { OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';

interface Collected {
  data: { channel: 'stdout' | 'stderr'; text: string }[];
  exit: (number | null)[];
  error: string[];
}

function makeManager(c: Collected): StreamManager {
  return new StreamManager({
    policy: { singleRun: false, maxStreams: 4 } as any,
    output: new OutputHandler({ mode: parseOutputMode('text') }),
    onStreamData: (_sid, data, channel) => c.data.push({ channel, text: Buffer.from(data).toString() }),
    onStreamExit: (_sid, code) => c.exit.push(code),
    onStreamError: (_sid, err) => c.error.push(err),
  });
}

async function waitFor(fn: () => boolean, ms = 4000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  if (fn()) return;
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

/**
 * Build `echo <marker>` whose SOURCE text can never match the bare marker: the
 * literal is split by an empty shell quote, so `echo DO''NE` prints `DONE`
 * while the tty's echo of the input line renders the quotes verbatim.
 *
 * A PTY echoes typed input back on the same stream as command output, so
 * waiting for a plain `echo DONE` marker resolves the moment the input is
 * echoed — before the command has produced a single byte.
 */
function echoMarker(marker: string): string {
  const cut = Math.ceil(marker.length / 2);
  return `echo ${marker.slice(0, cut)}''${marker.slice(cut)}`;
}

describe('StreamManager exec', () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    // Bind the agent to a writable temp dir; it is both the working directory
    // and the execution boundary.
    process.env.AGENT_DEFAULT_CWD = tmpdir();
  });
  afterEach(() => {
    process.env = { ...OLD };
  });

  it('delivers all stdout BEFORE reporting exit (no trailing-data loss)', async () => {
    const c: Collected = { data: [], exit: [], error: [] };
    const sm = makeManager(c);

    // A fast command: with child.on('exit') this raced and dropped output;
    // with child.on('close') the data must arrive before the exit callback.
    await sm.openCmdStream({ argv: ['sh', '-c', 'echo hello-out'] });
    await waitFor(() => c.exit.length > 0);

    const stdout = c.data.filter((d) => d.channel === 'stdout').map((d) => d.text).join('');
    expect(stdout).toContain('hello-out');
    expect(c.exit[0]).toBe(0);
    expect(c.error).toHaveLength(0);
  });

  it('tags stderr separately from stdout', async () => {
    const c: Collected = { data: [], exit: [], error: [] };
    const sm = makeManager(c);

    await sm.openCmdStream({ argv: ['sh', '-c', 'echo O_LINE; echo E_LINE 1>&2'] });
    await waitFor(() => c.exit.length > 0);

    const stdout = c.data.filter((d) => d.channel === 'stdout').map((d) => d.text).join('');
    const stderr = c.data.filter((d) => d.channel === 'stderr').map((d) => d.text).join('');
    expect(stdout).toContain('O_LINE');
    expect(stderr).toContain('E_LINE');
    expect(stdout).not.toContain('E_LINE');
  });

  it('propagates a non-zero exit code', async () => {
    const c: Collected = { data: [], exit: [], error: [] };
    const sm = makeManager(c);
    await sm.openCmdStream({ argv: ['sh', '-c', 'exit 7'] });
    await waitFor(() => c.exit.length > 0);
    expect(c.exit[0]).toBe(7);
  });

  it('rejects opening a command with a cwd outside the boundary', async () => {
    // Boundary is AGENT_DEFAULT_CWD (tmpdir, set in beforeEach); /etc is outside.
    const c: Collected = { data: [], exit: [], error: [] };
    const sm = makeManager(c);
    await expect(sm.openCmdStream({ argv: ['echo', 'x'], cwd: '/etc' })).rejects.toThrow(/allowed|cwd/i);
  });

  it('enforces a default output ceiling from config when the policy is silent', async () => {
    // Policy carries no maxOutBytes, so the operator-configured default must
    // apply. A tiny ceiling means a large output stream is cut off well short.
    process.env.MAX_OUT_BYTES = '1000';
    const c: Collected = { data: [], exit: [], error: [] };
    const sm = makeManager(c);

    await sm.openCmdStream({ argv: ['sh', '-c', 'head -c 200000 /dev/zero | tr "\\0" "a"'] });
    await waitFor(() => c.exit.length > 0);

    const delivered = c.data.reduce((n, d) => n + d.text.length, 0);
    expect(delivered).toBeLessThan(200000); // never the full stream
  });

  it('force-closes a stream that exceeds the wall-clock deadline', async () => {
    // No per-policy wall limit; the config default must reap a long sleeper.
    process.env.CMD_DEFAULT_WALL_MS = '200';
    const c: Collected = { data: [], exit: [], error: [] };
    const sm = makeManager(c);

    const start = Date.now();
    // Direct child (no shell) so SIGTERM reaps it; killing whole process
    // groups for shell pipelines is a separate, larger change.
    await sm.openCmdStream({ argv: ['sleep', '30'] });
    await waitFor(() => c.exit.length > 0, 5000);

    expect(Date.now() - start).toBeLessThan(5000); // killed long before 30s
  });

  it('does NOT force-close an interactive PTY on the command wall-clock', async () => {
    // Interactive terminals are bounded only by the idle timeout, never the
    // per-command wall-clock. A short CMD_DEFAULT_WALL_MS must leave the PTY
    // alive. Regression: PTYs used to inherit and arm this deadline and got
    // reaped mid-session at 60s.
    process.env.CMD_DEFAULT_WALL_MS = '200';
    const c: Collected = { data: [], exit: [], error: [] };
    const sm = makeManager(c);

    const sid = await sm.openPtyStream({ cols: 80, rows: 24 } as any);
    // Wait well past the wall-clock deadline with the session idle.
    await new Promise((r) => setTimeout(r, 600));

    expect(c.exit).toHaveLength(0); // still alive
    expect(sm.getStream(sid)?.endedAt).toBeUndefined();
    sm.closeStream(sid);
  });

  it('does NOT apply the cumulative output ceiling to a PTY', async () => {
    // A tiny MAX_OUT_BYTES must not truncate or close a terminal session that
    // legitimately streams far more than the ceiling over its lifetime.
    process.env.MAX_OUT_BYTES = '1000';
    const c: Collected = { data: [], exit: [], error: [] };
    const sm = makeManager(c);

    const sid = await sm.openPtyStream({ cols: 80, rows: 24 } as any);
    // Emit ~20KB through the terminal — 20x the ceiling. DONE is printed only
    // AFTER the 20KB and the marker is split in the source (see echoMarker), so
    // observing the bare marker proves every one of those bytes was already
    // delivered — PTY output is ordered. Previously the wait matched the tty's
    // echo of this very command line, so it resolved with ~118 bytes delivered
    // and the assertion below raced the actual output rather than testing it.
    sm.writeToStream(sid, Buffer.from(`head -c 20000 /dev/zero | tr "\\0" a; ${echoMarker('DONE')}\n`));
    await waitFor(() => c.data.some((d) => d.text.includes('DONE')), 15000, 'the PTY to emit 20KB then DONE');

    const delivered = c.data.reduce((n, d) => n + d.text.length, 0);
    expect(delivered).toBeGreaterThan(1000); // not cut off at the cap
    expect(c.exit).toHaveLength(0); // not closed with "Output limit exceeded"
    sm.closeStream(sid);
    // Above the global 10s testTimeout so the waitFor's own (descriptive)
    // timeout is what fires on a real regression, not an opaque test timeout.
  }, 20000);

  it.skipIf(process.platform !== 'linux')('does NOT reap a CPU-bound interactive PTY', async () => {
    // PTYs are exempt from the CPU/memory guard; a busy interactive command
    // must not be killed the way an over-budget command stream would be.
    const c: Collected = { data: [], exit: [], error: [] };
    const sm = new StreamManager({
      policy: { singleRun: false, maxStreams: 1, perStream: { maxCpuMs: 300 } } as any,
      output: new OutputHandler({ mode: parseOutputMode('text') }),
      onStreamData: (_sid, data, channel) => c.data.push({ channel, text: Buffer.from(data).toString() }),
      onStreamExit: (_sid, code) => c.exit.push(code),
      onStreamError: (_sid, err) => c.error.push(err),
    });

    const sid = await sm.openPtyStream({ cols: 80, rows: 24 } as any);
    sm.writeToStream(sid, Buffer.from('while :; do :; done\n'));
    // Peg the CPU for well past the 300ms budget a cmd stream would die at.
    await new Promise((r) => setTimeout(r, 1500));

    expect(c.exit).toHaveLength(0); // still alive despite burning CPU
    expect(sm.getStream(sid)?.endedAt).toBeUndefined();
    sm.closeStream(sid);
  });

  it.skipIf(process.platform !== 'linux')('kills a CPU-bound process that exceeds the CPU limit', async () => {
    const c: Collected = { data: [], exit: [], error: [] };
    const sm = new StreamManager({
      policy: { singleRun: false, maxStreams: 1, perStream: { maxCpuMs: 300 } } as any,
      output: new OutputHandler({ mode: parseOutputMode('text') }),
      onStreamData: () => {},
      onStreamExit: (_sid, code) => c.exit.push(code),
      onStreamError: (_sid, err) => c.error.push(err),
    });

    const start = Date.now();
    // Busy loop pegs a CPU; the /proc resource monitor must reap it once
    // accumulated CPU time passes the limit.
    await sm.openCmdStream({ argv: ['sh', '-c', 'while :; do :; done'] });
    await waitFor(() => c.exit.length > 0, 8000);

    expect(Date.now() - start).toBeLessThan(8000);
  });

  it('enforces the maxStreams concurrency cap', async () => {
    const c: Collected = { data: [], exit: [], error: [] };
    const sm = new StreamManager({
      policy: { singleRun: false, maxStreams: 1 } as any,
      output: new OutputHandler({ mode: parseOutputMode('text') }),
      onStreamData: () => {},
      onStreamExit: () => {},
      onStreamError: () => {},
    });
    // Long-running first stream holds the only slot.
    await sm.openCmdStream({ argv: ['sh', '-c', 'sleep 2'] });
    await expect(sm.openCmdStream({ argv: ['echo', 'x'] })).rejects.toThrow(/Maximum streams/i);
    sm.closeAllStreams('test done');
  });
});
