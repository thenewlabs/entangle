import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { initCrypto, generateCapId, generateSecret } from '@thenewlabs/entangle-crypto';
import { InvokeConnection } from '../../connect/src/connection.js';
import ptyMod from '@homebridge/node-pty-prebuilt-multiarch';

// End-to-end proof of the shared-terminal emulator-fidelity fix (per-window
// headless-xterm + serialize-based repaint). Three bugs, each exercised through
// the REAL stack: a spawned relay + `entangle serve --shared` child, driven by
// the actual InvokeConnection client (bugs 1 & 3, viewer-observed payloads) or a
// real node-pty TTY running the blue-bar host UI (bug 2, host repaint).
//
//   Bug 1: switching to a full-screen-app window repaints the app's CURRENT alt
//          frame (\x1b[?1049h + live marker), not stale bytes, without a redraw.
//   Bug 2: the host's real terminal is repainted clean after a full-screen app
//          quits (\x1b[?1049l) — no manual `clear`.
//   Bug 3: scrollback survives a window switch (the switch payload's serialized
//          frame carries early history lines).
//
// Assertions poll an accumulated buffer with a timeout (robust to chunking); we
// never assert on a single chunk or use fixed sleeps as correctness gates.

const repoRoot = process.cwd();
const RELAY = join(repoRoot, 'relay/dist/index.js');
const SERVE = join(repoRoot, 'serve/dist/index.js');
const ALT_APP = join(repoRoot, 'tests/test-utils/alt-screen-app.mjs');
const NODE = process.execPath;

const port = 8300 + Math.floor(Date.now() % 600);
const wsBase = `ws://127.0.0.1:${port}`;
const httpBase = `http://127.0.0.1:${port}`;

const waitFor = async (fn: () => boolean | Promise<boolean>, ms: number, label: string) => {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${label}${last ? ` (last error: ${last})` : ''}`);
};

/** Spawn a fresh `entangle serve --shared` bound to a pinned capability. */
async function spawnSharedServe(home: string): Promise<{ proc: ChildProcess; capId: string; S: string }> {
  mkdirSync(home, { recursive: true });
  const capId = generateCapId().capId;
  const S = generateSecret();
  const proc = spawn('node', [SERVE, 'start', '--server', httpBase, '--shared'], {
    env: {
      ...process.env,
      HOME: home,
      LOG_LEVEL: 'warn',
      ENTANGLE_CAPABILITY: `${httpBase}/cap/${capId}#S=${S}`,
      AGENT_DEFAULT_CWD: home,
    },
    stdio: 'ignore',
  });
  return { proc, capId, S };
}

/** Connect a viewer (InvokeConnection) and open its pty viewport on window 0. */
async function connectViewer(capId: string, S: string) {
  const conn = new InvokeConnection(capId, S);
  await waitFor(async () => {
    try { await conn.connect(`${wsBase}/relay/${capId}`); return true; } catch { return false; }
  }, 12000, 'authenticated connection');

  let buf = '';
  const decoder = new TextDecoder();
  let activeIndex = -1;
  conn.onWindowState((s) => { activeIndex = s.activeIndex; });

  await new Promise<void>((resolve, reject) => {
    const handle = conn.openPty({ cols: 80, rows: 24 }, {
      onOpened: () => resolve(),
      onData: (chunk) => { buf += decoder.decode(chunk); },
      onExit: () => {},
      onError: (m) => reject(new Error(m)),
    });
    (conn as any).__handle = handle;
  });
  const handle = (conn as any).__handle as { write(u: Uint8Array): void };
  const write = (s: string) => handle.write(new TextEncoder().encode(s));

  return {
    conn,
    write,
    getBuf: () => buf,
    resetBuf: () => { buf = ''; },
    getActive: () => activeIndex,
  };
}

let relay: ChildProcess | undefined;
const homes: string[] = [];
const serves: ChildProcess[] = [];

describe('E2E terminal emulator fidelity (bugs 1-3)', () => {
  beforeAll(async () => {
    await initCrypto();
    relay = spawn('node', [RELAY, 'start'], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn' },
      stdio: 'ignore',
    });
    await waitFor(async () => (await fetch(`${httpBase}/__health`)).ok, 12000, 'relay health');
  }, 30000);

  afterAll(async () => {
    for (const p of serves) { try { p.kill('SIGTERM'); } catch {} }
    await new Promise((r) => setTimeout(r, 300));
    for (const p of serves) { try { p.kill('SIGKILL'); } catch {} }
    try { relay?.kill('SIGTERM'); } catch {}
    await new Promise((r) => setTimeout(r, 200));
    try { relay?.kill('SIGKILL'); } catch {}
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  });

  // --- Bug 1 -------------------------------------------------------------------
  it('bug1: switching back to a full-screen-app window repaints its CURRENT alt frame', async () => {
    const home = join(tmpdir(), `entangle-fid1-${Date.now()}`);
    homes.push(home);
    const { proc, capId, S } = await spawnSharedServe(home);
    serves.push(proc);
    await waitFor(async () => {
      const h = await (await fetch(`${httpBase}/__health`)).json();
      return h.agents >= 1;
    }, 12000, 'serve registration (bug1)');

    const v = await connectViewer(capId, S);

    // Run the alt-screen helper in window 0; it enters the alt buffer and paints
    // an ever-incrementing ALT-FRAME marker without ever exiting.
    v.write(`${NODE} ${ALT_APP}\n`);
    await waitFor(() => v.getBuf().includes('\x1b[?1049h') && /ALT-FRAME-\d+/.test(v.getBuf()),
      12000, 'alt app entered alt screen + streamed a marker to the viewer');

    // Move this viewport onto a fresh new window (window 1). Wait until the
    // window-state confirms the switch so we can't race the select below.
    v.conn.newWindow();
    await waitFor(() => v.getActive() === 1, 8000, 'viewport moved to window 1');

    // Isolate the switch-back payload, then return to window 0.
    v.resetBuf();
    v.conn.selectWindow(0);

    // The repaint must carry the app's CURRENT alt frame WITHOUT the app redrawing.
    await waitFor(() => v.getBuf().includes('\x1b[?1049h') && /ALT-FRAME-\d+/.test(v.getBuf()),
      12000, 'switch-back repaint carried the live alt frame');

    const after = v.getBuf();
    expect(after).toContain('\x1b[?1049h');       // repaint re-enters the alt buffer
    expect(after).toMatch(/ALT-FRAME-\d+/);       // ...showing a current marker
    v.conn.disconnect();
  }, 45000);

  // --- Bug 3 -------------------------------------------------------------------
  it('bug3: scrollback survives a window switch (switch payload re-seeds early history)', async () => {
    const home = join(tmpdir(), `entangle-fid3-${Date.now()}`);
    homes.push(home);
    const { proc, capId, S } = await spawnSharedServe(home);
    serves.push(proc);
    await waitFor(async () => {
      const h = await (await fetch(`${httpBase}/__health`)).json();
      return h.agents >= 2;
    }, 12000, 'serve registration (bug3)');

    const v = await connectViewer(capId, S);

    // Print 72 numbered lines (= 3 * 24 rows) into window 0, so LINE-000 is well
    // above the 24-row visible viewport once printing finishes.
    v.write(`${NODE} -e "for(let i=0;i<72;i++)console.log('LINE-'+String(i).padStart(3,'0'))"\n`);
    await waitFor(() => v.getBuf().includes('LINE-071'), 12000, 'all 72 lines printed');

    // Move onto a fresh window, then switch back to window 0.
    v.conn.newWindow();
    await waitFor(() => v.getActive() === 1, 8000, 'viewport moved to window 1');
    v.resetBuf();
    v.conn.selectWindow(0);

    // The switch payload's serialized frame must include an EARLY history line
    // (LINE-000), proving the window's scrollback was re-seeded on the switch.
    await waitFor(() => v.getBuf().includes('LINE-000'), 12000, 'switch payload re-seeded scrollback (LINE-000)');

    const after = v.getBuf();
    expect(after).toContain('\x1b[3J');   // switchPayload wipes + rebuilds scrollback
    expect(after).toContain('LINE-000');  // ...and the early history is back
    expect(after).toContain('LINE-071');  // the visible tail is present too
    v.conn.disconnect();
  }, 45000);

  // --- Bug 2 -------------------------------------------------------------------
  it('bug2: host real terminal is repainted clean after a full-screen app quits', async () => {
    const home = join(tmpdir(), `entangle-fid2-${Date.now()}`);
    const runDir = join(home, 'run');
    mkdirSync(runDir, { recursive: true });
    homes.push(home);
    const capId = generateCapId().capId;
    const S = generateSecret();

    // Spawn `entangle serve --shared` on a REAL pty so the blue-bar host UI
    // (attachBarTerminal) runs; it daemonizes, and this foreground client renders
    // the bar + drives the repaint logic under test.
    const pty = (ptyMod as any).spawn(NODE, [SERVE, 'start', '--server', httpBase, '--shared'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        LOG_LEVEL: 'warn',
        ENTANGLE_CAPABILITY: `${httpBase}/cap/${capId}#S=${S}`,
        AGENT_DEFAULT_CWD: home,
        ENTANGLE_RUN_DIR: runDir,
      },
    });

    let host = '';
    pty.onData((d: string) => { host += d; });

    try {
      // Go-live: the welcome view prints the shareable URL (contains the capId).
      await waitFor(() => host.includes(capId), 20000, 'host go-live (URL shown)');

      // Ctrl-B then '1' → enter the shell view of window 1 (1-based tab = index 0).
      pty.write('\x02');
      pty.write('1');

      // Give the shell a UNIQUE prompt + a recent command marker, so the CURRENT
      // primary buffer is unmistakable. Confirm we are in shell view by waiting
      // for them to render on the host.
      const PROMPT = `HOSTPROMPT_${Math.floor(Math.random() * 1e6)}`;
      pty.write(`export PS1='${PROMPT}# '\n`);
      pty.write(`echo RECENT_CMD_MARKER\n`);
      await waitFor(() => host.includes(PROMPT) && host.includes('RECENT_CMD_MARKER'), 15000,
        'shell view live (custom prompt + recent command echoed)');

      // Run the full-screen helper; wait until the host is showing its alt frame.
      pty.write(`${NODE} ${ALT_APP}\n`);
      await waitFor(() => host.includes('ALT-FRAME'), 15000, 'host showing the alt frame');

      // Everything from here on is the post-quit repaint under test.
      const cutoff = host.length;
      pty.write('\x03'); // Ctrl-C: app leaves the alt buffer (\x1b[?1049l) and exits.

      // Wait for the host's forced repaint to fire: repaintShellFromFrame erases
      // every shell row (\x1b[<r>;1H\x1b[2K x23) then homes (\x1b[H). Its presence
      // proves the alt-exit repaint path triggered.
      const REPAINT_RE = /(?:\x1b\[\d+;1H\x1b\[2K){10,}\x1b\[H/;
      await waitFor(() => REPAINT_RE.test(host.slice(cutoff)), 15000,
        'host forced a repaint after alt-screen exit');

      const post = host.slice(cutoff);
      // These hold today: the app left the alt buffer and the host cleared+repainted.
      expect(post).toContain('\x1b[?1049l');  // the app left the alt buffer
      expect(post).toMatch(REPAINT_RE);       // the host cleared the shell rows

      // The frame the host paints AFTER that clear must be the CURRENT primary
      // screen — it must carry the recent command marker (and the custom prompt),
      // NOT the stale go-live/startup frame. This branch fixes that: the host no
      // longer paints the daemon's attach-time replay cache but requests a FRESH
      // frame over the `refresh` channel, so the alt-exit repaint reflects the
      // live primary. This test verifies that fixed behavior.
      const frame = post.slice(post.search(REPAINT_RE));
      expect(frame,
        'alt-exit repaint must carry the CURRENT primary frame (recent command), ' +
        'not the stale go-live replay').toContain('RECENT_CMD_MARKER');
      expect(frame).toContain(PROMPT);
    } finally {
      try { pty.write('\x02'); pty.write('x'); } catch {}
      try { pty.kill(); } catch {}
      // Kill any daemon left running in this test's isolated run dir.
      await new Promise<void>((resolve) => {
        const k = spawn('node', [SERVE, 'kill', '--all'], {
          env: { ...process.env, HOME: home, ENTANGLE_RUN_DIR: runDir, LOG_LEVEL: 'warn' },
          stdio: 'ignore',
        });
        k.on('exit', () => resolve());
        k.on('error', () => resolve());
      });
    }
  }, 60000);

  // --- Host scrollback / copy-mode pager --------------------------------------
  it('scroll: Ctrl-B [ opens the pager and Home reveals early history, q returns to live', async () => {
    const home = join(tmpdir(), `entangle-scroll-${Date.now()}`);
    const runDir = join(home, 'run');
    mkdirSync(runDir, { recursive: true });
    homes.push(home);
    const capId = generateCapId().capId;
    const S = generateSecret();

    // Real pty so the blue-bar host UI (attachBarTerminal) runs; it daemonizes and
    // this foreground client renders the bar + drives the copy-mode pager.
    const pty = (ptyMod as any).spawn(NODE, [SERVE, 'start', '--server', httpBase, '--shared'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        LOG_LEVEL: 'warn',
        ENTANGLE_CAPABILITY: `${httpBase}/cap/${capId}#S=${S}`,
        AGENT_DEFAULT_CWD: home,
        ENTANGLE_RUN_DIR: runDir,
      },
    });

    let host = '';
    pty.onData((d: string) => { host += d; });

    try {
      // Go-live (welcome view shows the URL with the capId).
      await waitFor(() => host.includes(capId), 20000, 'host go-live (URL shown)');

      // Ctrl-B then '1' → shell view of window 1 (1-based tab = index 0).
      pty.write('\x02');
      pty.write('1');

      // Print 72 numbered lines so LINE-000 scrolls off the 24-row viewport into
      // the emulator's scrollback (the pager's source).
      pty.write(`${NODE} -e "for(let i=0;i<72;i++)console.log('LINE-'+String(i).padStart(3,'0'))"\n`);
      await waitFor(() => host.includes('LINE-071'), 15000, 'all 72 lines printed on the host');

      // Ctrl-B [ → enter the pager. It switches the real terminal to the alt
      // screen (\x1b[?1049h) and draws its bottom bar (contains "scrollback").
      pty.write('\x02');
      pty.write('[');
      await waitFor(() => host.includes('\x1b[?1049h') && host.includes('scrollback'), 15000,
        'pager opened on the alt screen with its scrollback bar');

      // The pager starts at the BOTTOM (newest). LINE-000 is NOT rendered yet;
      // capture a cutoff, then jump Home to the top and prove the EARLY history
      // line is drawn by the pager (not merely present from the earlier live
      // print, which is before the cutoff).
      const cutoff = host.length;
      pty.write('\x1b[1~'); // Home
      await waitFor(() => host.slice(cutoff).includes('LINE-000'), 15000,
        'pager rendered the early history line (LINE-000) after Home');

      const paged = host.slice(cutoff);
      expect(paged).toContain('LINE-000'); // early scrollback line, drawn by the pager

      // q → leave the pager: back to the primary screen (\x1b[?1049l) and the live
      // shell repaints (the blue "entangle" bar reappears).
      const beforeQuit = host.length;
      pty.write('q');
      await waitFor(() => host.slice(beforeQuit).includes('\x1b[?1049l') && host.slice(beforeQuit).includes('entangle'),
        15000, 'pager exited to the live shell (left alt screen + bar repainted)');

      const afterQuit = host.slice(beforeQuit);
      expect(afterQuit).toContain('\x1b[?1049l'); // left the pager's alt screen
      expect(afterQuit).toContain('entangle');    // live status bar is back
    } finally {
      try { pty.write('q'); } catch {}          // ensure we're out of the pager
      try { pty.write('\x02'); pty.write('x'); } catch {}
      try { pty.kill(); } catch {}
      await new Promise<void>((resolve) => {
        const k = spawn('node', [SERVE, 'kill', '--all'], {
          env: { ...process.env, HOME: home, ENTANGLE_RUN_DIR: runDir, LOG_LEVEL: 'warn' },
          stdio: 'ignore',
        });
        k.on('exit', () => resolve());
        k.on('error', () => resolve());
      });
    }
  }, 60000);
});
