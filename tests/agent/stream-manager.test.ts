import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { StreamManager } from '../../agent/src/stream-manager.js';
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

async function waitFor(fn: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
}

describe('StreamManager exec', () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    // Unrestricted cwd by default for these tests; default to a writable dir.
    process.env.AGENT_ALLOWED_CWD = '';
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

  it('rejects opening a command with a cwd outside the allow-list', async () => {
    process.env.AGENT_ALLOWED_CWD = tmpdir(); // only the temp dir is allowed
    const c: Collected = { data: [], exit: [], error: [] };
    const sm = makeManager(c);
    await expect(sm.openCmdStream({ argv: ['echo', 'x'], cwd: '/etc' })).rejects.toThrow(/allowed|cwd/i);
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
