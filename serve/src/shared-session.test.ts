import { describe, it, expect, afterEach } from 'vitest';
import { OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';
import { SharedSession } from './shared-session.js';

// These are integration tests: SharedSession spawns a REAL shell PTY. We never
// rely on fixed sleeps to decide correctness — we poll for the expected output
// (a unique marker) with a timeout, and always kill() sessions so no PTY leaks.

const output = new OutputHandler({ mode: parseOutputMode('text') });

// Track every session we create so afterEach can guarantee no PTY survives a
// test, even if the test threw partway through.
const live: SharedSession[] = [];

function makeSession(opts?: {
  cols?: number;
  rows?: number;
  cwd?: string;
}): SharedSession {
  const s = new SharedSession(output, {
    cols: opts?.cols ?? 80,
    rows: opts?.rows ?? 24,
    ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
  live.push(s);
  return s;
}

afterEach(() => {
  while (live.length) {
    try { live.pop()!.kill(); } catch { /* already dead */ }
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `pred` until it returns true or `timeout` ms elapse. Deterministic
 * substitute for a fixed sleep: it returns as soon as the condition holds.
 */
async function waitFor(
  pred: () => boolean,
  { timeout = 6000, interval = 20, message = 'condition not met' }: {
    timeout?: number;
    interval?: number;
    message?: string;
  } = {}
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred()) return;
    await delay(interval);
  }
  if (pred()) return;
  throw new Error(`waitFor timed out after ${timeout}ms: ${message}`);
}

const decode = (u: Uint8Array): string => Buffer.from(u).toString('utf8');

describe('SharedSession (integration, real PTY)', () => {
  it('emits host output for shell commands', async () => {
    const s = makeSession();
    let host = '';
    s.onHostData((chunk) => { host += chunk.toString('utf8'); });

    s.write('echo HOSTMARK\n');

    await waitFor(() => host.includes('HOSTMARK'), { message: 'host never saw HOSTMARK' });
    expect(host).toContain('HOSTMARK');
  }, 10000);

  it('broadcasts host output to a viewer attached before the write', async () => {
    const s = makeSession();
    let viewer = '';
    s.attach({
      sid: 'v1',
      onData: (chunk) => { viewer += decode(chunk); },
      onExit: () => {},
    });

    s.write('echo BCASTMARK\n');

    await waitFor(() => viewer.includes('BCASTMARK'), { message: 'viewer never saw BCASTMARK' });
    expect(viewer).toContain('BCASTMARK');
  }, 10000);

  it('replays earlier output to a late-joining viewer and streams new output', async () => {
    const s = makeSession();
    let host = '';
    s.onHostData((chunk) => { host += chunk.toString('utf8'); });

    // Produce some output BEFORE anyone attaches.
    s.write('echo EARLYMARK\n');
    await waitFor(() => host.includes('EARLYMARK'), { message: 'host never saw EARLYMARK' });

    // A late joiner gets the prior output through the serialized snapshot (the
    // emulator's current screen, which still shows EARLYMARK).
    let late = '';
    const { replay } = s.attach({
      sid: 'late',
      onData: (chunk) => { late += decode(chunk); },
      onExit: () => {},
    });

    expect(replay).toBeInstanceOf(Uint8Array);
    expect(decode(replay)).toContain('EARLYMARK');

    // getReplay() returns the same snapshot content on demand.
    expect(decode(s.getReplay())).toContain('EARLYMARK');

    // The late viewer still receives subsequent live output.
    s.write('echo LATERMARK\n');
    await waitFor(() => late.includes('LATERMARK'), { message: 'late viewer never saw LATERMARK' });
    expect(late).toContain('LATERMARK');
    // It must NOT have received the earlier output via the live stream (only replay).
    expect(late).not.toContain('EARLYMARK');
  }, 10000);

  it('stops delivering output to a viewer after detach', async () => {
    const s = makeSession();
    let host = '';
    s.onHostData((chunk) => { host += chunk.toString('utf8'); });

    let viewer = '';
    s.attach({
      sid: 'v1',
      onData: (chunk) => { viewer += decode(chunk); },
      onExit: () => {},
    });

    // First marker while attached — viewer should see it.
    s.write('echo BEFOREDETACH\n');
    await waitFor(() => viewer.includes('BEFOREDETACH'), { message: 'viewer never saw BEFOREDETACH' });

    s.detach('v1');
    expect(s.viewerCount()).toBe(0);

    // Second marker after detach — the host still sees it, the viewer must not.
    s.write('echo AFTERDETACH\n');
    await waitFor(() => host.includes('AFTERDETACH'), { message: 'host never saw AFTERDETACH' });
    // Give any (erroneous) in-flight delivery a chance to land before asserting.
    await delay(100);

    expect(viewer).not.toContain('AFTERDETACH');
  }, 10000);

  it('tracks viewerCount and fires onViewersChange on attach/detach', async () => {
    const s = makeSession();
    const counts: number[] = [];
    s.onViewersChange((c) => { counts.push(c); });

    expect(s.viewerCount()).toBe(0);

    s.attach({ sid: 'a', onData: () => {}, onExit: () => {} });
    expect(s.viewerCount()).toBe(1);

    s.attach({ sid: 'b', onData: () => {}, onExit: () => {} });
    expect(s.viewerCount()).toBe(2);

    s.detach('a');
    expect(s.viewerCount()).toBe(1);

    // Detaching an unknown sid must not change the count nor fire a callback.
    s.detach('does-not-exist');
    expect(s.viewerCount()).toBe(1);

    s.detach('b');
    expect(s.viewerCount()).toBe(0);

    expect(counts).toEqual([1, 2, 1, 0]);
  }, 10000);

  it('snapshot reflects an alt-screen frame then the restored primary after exit', async () => {
    const s = makeSession();
    let host = '';
    s.onHostData((chunk) => { host += chunk.toString('utf8'); });

    // Suppress input echo + the prompt so the screen holds only program output
    // (otherwise the shell echoes the typed marker text onto the PRIMARY screen).
    s.write("stty -echo; PS1=''\n");
    await waitFor(() => host.includes('stty -echo'), { message: 'shell not ready' });
    await delay(150);

    // Enter the alt buffer and print a marker there; the serialized snapshot must
    // reconstruct the CURRENT (alt) frame — the marker + the 1049h enter toggle.
    s.write("printf '\\033[?1049h'; echo ALTFRAME_MARK\n");
    await waitFor(() => decode(s.snapshot()).includes('ALTFRAME_MARK'), {
      message: 'snapshot never showed the alt frame',
    });
    expect(decode(s.snapshot())).toContain('ALTFRAME_MARK');
    expect(decode(s.snapshot())).toContain('\x1b[?1049h');

    // Leave the alt buffer and print a primary marker; the snapshot now shows the
    // restored primary (with PRIMARY_MARK) and no longer the alt marker.
    s.write("printf '\\033[?1049l'; echo PRIMARY_MARK\n");
    await waitFor(() => decode(s.snapshot()).includes('PRIMARY_MARK'), {
      message: 'snapshot never showed the restored primary',
    });
    const snap = decode(s.snapshot());
    expect(snap).toContain('PRIMARY_MARK');
    expect(snap).not.toContain('ALTFRAME_MARK');
  }, 15000);

  it('scrollbackLines() returns buffer history (early + late lines) in order', async () => {
    const s = makeSession();
    let host = '';
    s.onHostData((chunk) => { host += chunk.toString('utf8'); });

    // Quiet the prompt/echo so the buffer holds our lines cleanly, then print a
    // batch of distinct numbered lines that overflow the 24-row screen so an
    // EARLY one lands in scrollback while a LATE one is on the current screen.
    s.write("stty -echo; PS1=''\n");
    await waitFor(() => host.includes('stty -echo'), { message: 'shell not ready' });
    s.write('for i in $(seq 0 71); do printf "SBLINE-%03d\\n" "$i"; done\n');

    // Poll the emulator buffer (not the raw stream) until the last line is in.
    await waitFor(() => s.scrollbackLines().some((l) => l.includes('SBLINE-071')), {
      message: 'scrollbackLines never showed the last line',
    });

    const lines = s.scrollbackLines();
    const early = lines.findIndex((l) => l.includes('SBLINE-000'));
    const late = lines.findIndex((l) => l.includes('SBLINE-071'));
    // Both present, and the early line comes before the late one (oldest first).
    expect(early).toBeGreaterThanOrEqual(0);
    expect(late).toBeGreaterThan(early);
    // Trailing whitespace is trimmed (translateToString(true)).
    expect(lines[early]).toBe('SBLINE-000');
  }, 15000);

  it('fires onExit for the session and attached viewers when the shell exits', async () => {
    const s = makeSession();
    let exited = false;
    let exitCode: number | null | undefined;
    s.onExit((code) => { exited = true; exitCode = code; });

    let viewerExited = false;
    s.attach({
      sid: 'v1',
      onData: () => {},
      onExit: () => { viewerExited = true; },
    });

    s.write('exit\n');

    await waitFor(() => exited, { message: 'session onExit never fired' });
    expect(exited).toBe(true);
    expect(s.hasExited).toBe(true);
    // exit with no args yields code 0 (may be null on signal, but here it exits cleanly).
    expect(exitCode === 0 || exitCode === null).toBe(true);

    await waitFor(() => viewerExited, { message: 'viewer onExit never fired' });
    expect(viewerExited).toBe(true);

    // Writes after exit are ignored (no throw).
    expect(() => s.write('echo IGNORED\n')).not.toThrow();
  }, 10000);

  it('fires onExit when the session is killed', async () => {
    const s = makeSession();
    let exited = false;
    let viewerExited = false;
    s.onExit(() => { exited = true; });
    s.attach({ sid: 'v1', onData: () => {}, onExit: () => { viewerExited = true; } });

    s.kill();

    await waitFor(() => exited, { message: 'onExit never fired after kill' });
    expect(exited).toBe(true);
    expect(s.hasExited).toBe(true);
    await waitFor(() => viewerExited, { message: 'viewer onExit never fired after kill' });
    expect(viewerExited).toBe(true);
  }, 10000);
});
