import { OutputHandler } from '@thenewlabs/entangle-utils';
// The host binds to a HostSession via the same host-facing surface it used on a
// single SharedSession (onHostData/onViewersChange/onExit/resize/write/getReplay/
// viewerCount), so it renders the ACTIVE window and repaints automatically on a
// remote window switch (the session pushes a clear+replay through onHostData).
// The host also renders its own tmux-style status bar by subscribing to the
// session's onWindowState and drives window ops via a Ctrl-B prefix keymap. The
// debug tab, captured-log buffer and session URL all come from the HostSession,
// so this UI is decoupled from the concrete in-process workspace.
import type { WindowInfo } from '@thenewlabs/entangle-protocol';
import type { HostSession } from './host-session.js';

/** Minimum terminal size that can hold the shell plus a bottom status bar. */
const MIN_COLS = 20;
const MIN_ROWS = 6;

/** Repaint cadence for the status bar: coalesce shell output into ~30ms frames. */
const FRAME_MS = 30;

/**
 * How long a shell-repaint waits for a fresh `refresh` frame before falling back
 * to the synchronous getReplay() cache. A NEW daemon answers a local-socket
 * round-trip well under this; the fallback only fires against an OLD daemon
 * (pre-`refresh`, surviving a `serve` upgrade) that never answers requestFrame.
 */
const FRAME_FALLBACK_MS = 250;

/** Host window-management prefix (Ctrl-B), tmux-style. */
const PREFIX = 0x02;

/** Status-bar palette (tmux-style blue). */
const BAR_BG = '\x1b[48;5;25m'; // base blue background
const BAR_ACTIVE_BG = '\x1b[48;5;33m'; // brighter blue for the active tab
const BAR_FG = '\x1b[97m'; // bright white text
const RESET = '\x1b[0m';

/** SGR mouse reporting: enable/disable click reporting for the status bar. */
const MOUSE_ENABLE = '\x1b[?1000h\x1b[?1006h';
const MOUSE_DISABLE = '\x1b[?1000l\x1b[?1006l';

/** A clickable status-bar segment: a 1-based inclusive column span + its action. */
interface ClickTarget {
  start: number;
  end: number;
  action: () => void;
}

/** A parsed SGR mouse event (`\x1b[<b;x;y` then `M`=press / `m`=release). */
interface MouseEvent {
  length: number; // total bytes consumed from the input buffer
  button: number;
  col: number; // 1-based column
  row: number; // 1-based row
  press: boolean;
}

/**
 * Try to parse a well-formed SGR mouse sequence at `i` in `d`. Returns null for
 * anything that isn't a complete `\x1b[<b;x;y(M|m)` so it passes through as
 * ordinary input (including partial sequences split across chunks).
 */
function matchMouse(d: Buffer, i: number): MouseEvent | null {
  if (d[i] !== 0x1b || d[i + 1] !== 0x5b /* [ */ || d[i + 2] !== 0x3c /* < */) return null;
  let j = i + 3;
  const readNum = (): number | null => {
    let n = 0;
    let any = false;
    while (j < d.length && d[j]! >= 0x30 && d[j]! <= 0x39) { n = n * 10 + (d[j]! - 0x30); j++; any = true; }
    return any ? n : null;
  };
  const button = readNum(); if (button === null) return null;
  if (d[j] !== 0x3b /* ; */) return null; j++;
  const col = readNum(); if (col === null) return null;
  if (d[j] !== 0x3b) return null; j++;
  const row = readNum(); if (row === null) return null;
  const fin = d[j];
  if (fin !== 0x4d /* M */ && fin !== 0x6d /* m */) return null;
  return { length: j - i + 1, button, col, row, press: fin === 0x4d };
}

/**
 * Wire the host's own terminal to the {@link HostSession}.
 *
 * On a real, big-enough terminal the host sees their shell rendered RAW at full
 * width, using rows 1..(rows-1), with a blue tmux-style status bar pinned to the
 * bottom row. The shell is authoritative-sized to (cols, rows-1) and a scroll
 * region keeps its scrolling clear of the bar; because output is passed through
 * byte-for-byte (no VtGrid), resizes stay clean. Elsewhere (too small, or not a
 * TTY) it falls back to raw pass-through.
 *
 * The session URL is only known once the relay assigns the capability, so the
 * host subscribes to {@link HostSession.onUrl} and shows a brief "connecting…"
 * screen until it arrives (index.ts sets it on the session).
 */
export function attachHostTerminal(session: HostSession, output: OutputHandler): void {
  const stdout = process.stdout;
  const stdin = process.stdin;

  const cols = stdout.columns || 0;
  const rows = stdout.rows || 0;
  const barCapable =
    !!stdout.isTTY && !!stdin.isTTY && cols >= MIN_COLS && rows >= MIN_ROWS;

  if (barCapable) attachBarTerminal(session, output, cols, rows);
  else attachRawTerminal(session, output);
}

/**
 * Blue-bottom-bar UI (the normal interactive host experience).
 *
 * Launch sequence: clear + "connecting…" on attach; then on the URL arriving
 * clear again, set the scroll region, size the shell to rows-1, enable SGR mouse
 * reporting for the clickable bar, and go live on the WELCOME/log view (the
 * pinned banner header + live event-log tail). The shell keeps running in the
 * background; the host reaches it by clicking a window tab or Ctrl-B <digit>/n,
 * which repaints it from the replay. The `⧉ entangle` bar label doubles as the
 * button back to the welcome/log view.
 */
function attachBarTerminal(
  session: HostSession,
  output: OutputHandler,
  initialCols: number,
  initialRows: number,
): void {
  const stdout = process.stdout;
  const stdin = process.stdin;

  const write = (s: string) => { try { stdout.write(s); } catch {} };
  const writeRaw = (b: Uint8Array) => { try { stdout.write(Buffer.from(b)); } catch {} };

  let cols = initialCols;
  let rows = initialRows;

  let live = false; // true once the URL is known and we're in pass-through
  let viewers = session.viewerCount();
  let barDirty = false;

  // Which surface fills the shell area (rows 1..rows-1). 'shell' is the raw
  // pass-through; 'debug' is the welcome/log view (pinned banner + event-log
  // tail); 'scroll' is the tmux-style copy-mode pager over the active window's
  // emulator buffer (see enterScroll/renderScroll below). We DEFAULT to 'debug'
  // so the first thing the host sees on go-live is the welcome screen with the
  // shareable URL; a window tab/Ctrl-B digit or n reveals the shell.
  let viewMode: 'shell' | 'debug' | 'scroll' = 'debug';

  // Copy-mode pager state. `scrollLines` is the PLAIN-TEXT snapshot of the active
  // window's emulator buffer (scrollback history + current screen, oldest first)
  // fetched on entry via session.requestScrollback(); `scrollOffset` is the index
  // of the TOP visible line. SGR/colour reconstruction is a non-goal — the pager
  // renders history text only.
  let scrollLines: string[] = [];
  let scrollOffset = 0;
  // The captured agent logs live in the session's ring buffer (the session owns
  // the OutputHandler sink); the welcome/log view renders the tail of that
  // buffer and marks itself dirty when a new line arrives while it's showing.
  let debugDirty = false;

  // Clickable segments of the bar (rebuilt each buildBar), mapping a 1-based
  // column span on the bar row to an action (the entangle label → welcome/log
  // view; each window tab → switch to that window).
  let clickTargets: ClickTarget[] = [];

  // Which DEC mouse-tracking modes the SHELL app has enabled, scanned from its
  // output. When any is on, the app (vim/htop) wants mouse events, so we forward
  // raw off-bar mouse sequences to it; otherwise we swallow them so bash doesn't
  // receive click garbage. Mode 1006 is just SGR encoding, not a tracking mode.
  const appMouseModes = new Set<string>();
  const appMouseOn = (): boolean =>
    appMouseModes.has('1000') || appMouseModes.has('1002') || appMouseModes.has('1003');
  const MOUSE_MODE_RE = /\x1b\[\?(1000|1002|1003|1006)(h|l)/g;
  const scanAppMouse = (buf: Uint8Array): void => {
    const s = Buffer.from(buf).toString('latin1');
    MOUSE_MODE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MOUSE_MODE_RE.exec(s)) !== null) {
      if (m[2] === 'h') appMouseModes.add(m[1]!);
      else appMouseModes.delete(m[1]!);
    }
  };

  // Which DEC ALTERNATE-SCREEN modes (1049/1047/47) the SHELL app has enabled,
  // scanned from its output. On a real terminal, when a full-screen app QUITS it
  // emits the alt-off toggle (`\x1b[?1049l`), and the terminal restores its own
  // saved PRIMARY buffer — which is stale under entangle's reserved scroll region
  // + bar. So on a transition to alt-inactive (while we're on the shell view) we
  // schedule a coalesced repaint from the emulator's correct primary viewport
  // (Bug 2). Detection is per-chunk (like the mouse scan); the coalescing timer
  // absorbs rapid/split toggles into a single repaint on the next frame.
  const appAltModes = new Set<string>();
  const appAltOn = (): boolean =>
    appAltModes.has('1049') || appAltModes.has('1047') || appAltModes.has('47');
  const ALT_MODE_RE = /\x1b\[\?(1049|1047|47)(h|l)/g;
  let altExitDirty = false;
  const scanAppAlt = (buf: Uint8Array): void => {
    const s = Buffer.from(buf).toString('latin1');
    ALT_MODE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ALT_MODE_RE.exec(s)) !== null) {
      if (m[2] === 'h') appAltModes.add(m[1]!);
      // Only a transition OUT of an alt mode we saw enter needs a forced repaint;
      // entering alt is left to the app (it paints its own frame). Off in debug.
      else if (appAltModes.delete(m[1]!) && viewMode === 'shell') altExitDirty = true;
    }
  };

  // Local mirror of the session's window set, kept in sync via onWindowState
  // and rendered as the tab row of the bar. Seeded with the current state.
  const initialState = session.windowState();
  let windows: readonly WindowInfo[] = initialState.windows;
  let activeIndex = initialState.activeIndex;

  /**
   * Compose the status bar for the bottom row: ` ⧉ entangle ` (which doubles as
   * the welcome/log button — brighter blue while the log view shows) then 1-based
   * window tabs (the active one in brighter blue) and a right-aligned viewer
   * count, all on blue and padded/truncated to exactly `cols` visible columns.
   * Side effect: records each clickable segment's column span into clickTargets.
   */
  const buildBar = (): string => {
    const targets: ClickTarget[] = [];
    const segs: Array<{ text: string; active: boolean; action?: () => void }> = [
      // The brand label is the welcome/log button; active while in that view.
      { text: ' ⧉ entangle ', active: viewMode === 'debug', action: () => enterDebug() },
    ];
    for (let i = 0; i < windows.length; i++) {
      const title = (windows[i]!.title || '').replace(/[\x00-\x1f\x7f]/g, '');
      const idx = i;
      segs.push({
        text: ` ${i + 1}:${title} `,
        active: viewMode === 'shell' && i === activeIndex,
        action: () => { enterShell(); session.selectWindow(idx); },
      });
    }
    const viewerSeg = ` ${viewers} viewer${viewers === 1 ? '' : 's'} `;

    // Reserve room on the right for the viewer count when it fits.
    const showViewer = viewerSeg.length + 1 <= cols;
    const leftBudget = showViewer ? cols - viewerSeg.length : cols;

    // Emit the left segments up to leftBudget visible columns, truncating the
    // last one that overflows (each active segment is wrapped in its own bg).
    // Record the on-screen column span of each clickable segment for hit-testing.
    let left = '';
    let leftVis = 0;
    for (const s of segs) {
      if (leftVis >= leftBudget) break;
      const room = leftBudget - leftVis;
      const text = s.text.length > room ? s.text.slice(0, room) : s.text;
      if (s.action) targets.push({ start: leftVis + 1, end: leftVis + text.length, action: s.action });
      left += s.active ? `${BAR_ACTIVE_BG}${text}${BAR_BG}` : text;
      leftVis += text.length;
    }

    const fill = ' '.repeat(Math.max(0, cols - leftVis - (showViewer ? viewerSeg.length : 0)));
    const right = showViewer ? viewerSeg : '';
    clickTargets = targets;
    return `${BAR_BG}${BAR_FG}${left}${fill}${right}${RESET}`;
  };

  // Draw the bar on the bottom row without disturbing the shell: save the cursor
  // and its attributes (DECSC), jump to the last row, clear it, paint the bar,
  // then restore (DECRC). No-op until live so the connecting screen stays clean.
  const drawBar = () => {
    if (!live) return;
    // While the copy-mode pager is up it owns the bottom row (its own
    // `⧉ scrollback …` bar via renderScroll); async triggers (onViewersChange /
    // onWindowState) must not paint the blue `⧉ entangle` bar over it. The pager
    // repaints its bar itself on the next keypress, so just suppress here.
    if (viewMode === 'scroll') return;
    barDirty = false;
    write(`\x1b7\x1b[${rows};1H\x1b[2K${buildBar()}\x1b8`);
  };

  // The welcome banner lines (brand, intro, share URL, key hint) — the pinned
  // header of the welcome/log view. Shows `connecting…` for the URL until known.
  const bannerLines = (link: string | null): string[] => [
    `${BAR_FG}⧉ entangle${RESET} — live shared session`,
    `A shared terminal others can join at the URL below.`,
    ``,
    `Share this live session:`,
    `  ${BAR_FG}${link ?? 'connecting…'}${RESET}`,
    ``,
    `Ctrl-B  [=scroll  d=detach  l=logs  c=new  n/p=win  1-9=select  x=close`,
  ];

  // Render the welcome/log view: a PINNED HEADER (brand, intro, share URL, key
  // hint) at the top so the URL is always findable, a "Recent activity:"
  // separator, then the tail of the event-log buffer that fits (viewer
  // connect/disconnect lines land here), then repaint the bar. No scrollback —
  // just the last rows.
  const renderDebug = () => {
    if (!live) return;
    debugDirty = false;
    const shellRows = Math.max(1, rows - 1);
    const header = bannerLines(session.getUrl());
    const sep = `${BAR_FG}Recent activity:${RESET}`;
    const headerRows = header.length + 1; // banner lines + the separator line
    const tailRows = Math.max(0, shellRows - headerRows);
    const lines = tailRows > 0 ? session.getLogBuffer().slice(-tailRows) : [];
    let out = '';
    let r = 0;
    for (; r < header.length && r < shellRows; r++) {
      out += `\x1b[${r + 1};1H\x1b[2K${header[r]}`; // header lines print as-is
    }
    if (r < shellRows) { out += `\x1b[${r + 1};1H\x1b[2K${sep}`; r++; } // separator
    for (let i = 0; r < shellRows; r++, i++) {
      out += `\x1b[${r + 1};1H\x1b[2K`; // move to row, clear it
      const line = lines[i];
      if (line !== undefined) out += line.length > cols ? line.slice(0, cols) : line;
    }
    write(out);
    drawBar();
  };

  // Paint the live shell area from a FRESH serialized `frame` over rows
  // 1..rows-1, WITHOUT touching the host's scrollback (no \x1b[3J). Clears just
  // the reserved shell rows, homes, then writes the frame; the frame may itself
  // carry \x1b[?1049h + alt content, which correctly reproduces a full-screen
  // app's current screen (Bug 1 / Bug 2 host repaint). The frame source is the
  // session's onFrame callback (a fresh serialize), NOT the synchronous
  // getReplay() cache — which is stale in daemon mode (Bug 2).
  const paintShellFrame = (frame: Uint8Array) => {
    if (!live) return;
    const shellRows = Math.max(1, rows - 1);
    let out = '';
    for (let r = 1; r <= shellRows; r++) out += `\x1b[${r};1H\x1b[2K`;
    out += '\x1b[H';
    write(out);
    if (frame.length > 0) writeRaw(frame);
    drawBar();
    // The frame may have re-disabled mouse (e.g. it serializes a primary screen
    // after a full-screen app quit); re-assert our bar-click reporting so the bar
    // stays clickable.
    write(MOUSE_ENABLE);
  };

  // Cross-version fallback for a shell repaint. A NEW foreground client can attach
  // to an OLD long-lived daemon (the detach/reattach daemon survives a `serve`
  // upgrade) that predates the `refresh` frame channel and so never answers
  // requestFrame — leaving alt-exit / window-switch / leave-debug repaints blank.
  // So on each repaint we arm a short timer: if onFrame delivers first it cancels
  // the timer and paints the fresh frame; if the timer wins (old daemon silent)
  // we paint from the synchronous getReplay() cache — stale in daemon mode but
  // non-empty (the pre-fix behavior), which beats a blank/stale screen.
  let pendingFrameTimer: ReturnType<typeof setTimeout> | undefined;
  const clearFrameFallback = () => {
    if (pendingFrameTimer) { clearTimeout(pendingFrameTimer); pendingFrameTimer = undefined; }
  };
  // Ask for a fresh frame and arm the old-daemon fallback. The timer is armed
  // BEFORE requestFrame so the in-process (synchronous) onFrame cancels it inline
  // — no double paint. Against a NEW daemon the fresh frame arrives well under
  // FRAME_FALLBACK_MS, cancelling the timer before it can fire (no flicker).
  const requestFrameWithFallback = () => {
    clearFrameFallback();
    pendingFrameTimer = setTimeout(() => {
      pendingFrameTimer = undefined;
      if (!live || viewMode !== 'shell') return;
      paintShellFrame(session.getReplay({ scrollback: 0 }));
    }, FRAME_FALLBACK_MS);
    pendingFrameTimer.unref?.();
    session.requestFrame({ scrollback: 0 });
  };

  // Request a fresh frame for the alt-screen-exit repaint. The actual paint
  // happens asynchronously in the onFrame handler with the FRESH frame (a
  // daemon round-trip in daemon mode, synchronous in-process). `scrollback:0`
  // keeps the host's real terminal from being flooded with window history.
  const repaintShellFromFrame = () => {
    if (!live) return;
    altExitDirty = false; // any pending alt-exit repaint is subsumed by this one
    requestFrameWithFallback();
  };

  // Repaint the live shell area when leaving the debug view or switching windows:
  // request a fresh frame; the onFrame handler paints it.
  const repaintShell = () => {
    if (!live) return;
    requestFrameWithFallback();
  };

  const enterDebug = () => {
    if (viewMode === 'debug') return;
    viewMode = 'debug';
    renderDebug();
  };
  // Leave the debug view for the shell, repainting the live screen. A no-op
  // (beyond the repaint) when already in shell view.
  const enterShell = () => {
    const wasDebug = viewMode === 'debug';
    viewMode = 'shell';
    if (wasDebug) repaintShell();
  };

  // --- copy-mode / scrollback pager ----------------------------------------
  // A tmux-style pager over the active window's emulator buffer. On entry we
  // switch the host's REAL terminal to the alternate screen (so the live shell
  // view is saved and restored verbatim on exit), drop our reserved scroll
  // region, and render a scrollable window of PLAIN-TEXT buffer lines with a
  // distinct bottom bar. Keystrokes drive the pager and are NOT sent to the
  // shell; `q`/Esc returns to the live shell.

  /** Largest valid top-line index: the last full page starts here. */
  const maxScrollOffset = (): number => Math.max(0, scrollLines.length - (rows - 1));
  const clampScrollOffset = (): void => {
    scrollOffset = Math.max(0, Math.min(maxScrollOffset(), scrollOffset));
  };

  // The pager's bottom bar: brand + position readout + key legend, styled like
  // the status bar (blue) and padded/truncated to exactly `cols`.
  const buildScrollBar = (): string => {
    const total = scrollLines.length;
    const top = total === 0 ? 0 : scrollOffset + 1;
    const bottom = Math.min(total, scrollOffset + Math.max(1, rows - 1));
    let label = ` ⧉ scrollback  [${top}-${bottom}/${total}]  ↑↓ PgUp/PgDn  Home/End  q:live `;
    if (label.length > cols) label = label.slice(0, cols);
    const fill = ' '.repeat(Math.max(0, cols - label.length));
    return `${BAR_BG}${BAR_FG}${label}${fill}${RESET}`;
  };

  // Draw the pager: rows 1..(rows-1) show scrollLines[scrollOffset ..], each
  // cleared then truncated to `cols`; rows past the end are left blank; the
  // pager bar owns the bottom row.
  const renderScroll = (): void => {
    if (!live || viewMode !== 'scroll') return;
    const bodyRows = Math.max(1, rows - 1);
    let out = '';
    for (let r = 0; r < bodyRows; r++) {
      out += `\x1b[${r + 1};1H\x1b[2K`;
      const line = scrollLines[scrollOffset + r];
      if (line) out += line.length > cols ? line.slice(0, cols) : line;
    }
    out += `\x1b[${rows};1H\x1b[2K${buildScrollBar()}`;
    write(out);
  };

  // Enter the pager (only from the live shell view). Switch the real terminal to
  // the alt screen (saves the shell view for exit), drop the scroll region, hide
  // the cursor, then ask for a fresh scrollback snapshot; the onScrollback
  // handler renders it starting at the bottom (newest).
  const enterScroll = (): void => {
    if (!live || viewMode !== 'shell') return;
    viewMode = 'scroll';
    write('\x1b[?1049h'); // enter alt screen on the host's REAL terminal
    write('\x1b[r');      // drop our reserved scroll region while paging
    write('\x1b[?25l');   // hide the cursor for a clean pager
    // NOTE: against an OLD daemon (pre-`refresh`, surviving a `serve` upgrade)
    // requestScrollback goes unanswered and the pager shows empty — an accepted
    // limitation of this brand-new feature; we deliberately don't add a second
    // fallback path for it (unlike the shell-repaint fallback above).
    session.requestScrollback();
  };

  // Leave the pager: return the real terminal to the primary screen (which
  // restores the saved live shell view), re-arm our scroll region, re-assert
  // mouse reporting, then request a FRESH frame so the shell repaints its
  // CURRENT state (it may have advanced while we were paused).
  const exitScroll = (): void => {
    if (viewMode !== 'scroll') return;
    viewMode = 'shell';
    scrollLines = [];
    scrollOffset = 0;
    write('\x1b[?1049l');               // leave alt screen → restores the live shell view
    write('\x1b[?25h');                 // show the cursor again
    write(`\x1b[1;${Math.max(1, rows - 1)}r`); // re-arm the shell's scroll region
    write(MOUSE_ENABLE);                // keep bar-click / wheel reporting alive
    session.requestFrame({ scrollback: 0 }); // repaint the CURRENT live shell
  };

  // Drive the pager from a raw input chunk (called only while in 'scroll'). Keys
  // move the viewport; `q`/lone-Esc exits. Mouse wheel (SGR button 64/65) scrolls
  // by 3. Anything unrecognized is ignored (never forwarded to the shell). A lone
  // trailing ESC is treated as exit; a split ESC/CSI across chunks can mis-fire
  // exit, which is an acceptable edge for a pager.
  const handleScrollInput = (d: Buffer): void => {
    const s = d.toString('latin1');
    const page = Math.max(1, rows - 1);
    let changed = false;
    for (let i = 0; i < s.length; ) {
      const mouse = matchMouse(d, i);
      if (mouse) {
        if (mouse.press && mouse.button === 64) { scrollOffset -= 3; changed = true; }
        else if (mouse.press && mouse.button === 65) { scrollOffset += 3; changed = true; }
        i += mouse.length;
        continue;
      }
      if (s[i] === '\x1b') {
        const rest = s.slice(i);
        let consumed = 1;
        if (rest.startsWith('\x1b[A')) { scrollOffset -= 1; consumed = 3; }
        else if (rest.startsWith('\x1b[B')) { scrollOffset += 1; consumed = 3; }
        else if (rest.startsWith('\x1b[5~')) { scrollOffset -= page; consumed = 4; }
        else if (rest.startsWith('\x1b[6~')) { scrollOffset += page; consumed = 4; }
        else if (rest.startsWith('\x1b[1~')) { scrollOffset = 0; consumed = 4; }
        else if (rest.startsWith('\x1b[4~')) { scrollOffset = maxScrollOffset(); consumed = 4; }
        else if (rest.startsWith('\x1b[H')) { scrollOffset = 0; consumed = 3; }
        else if (rest.startsWith('\x1b[F')) { scrollOffset = maxScrollOffset(); consumed = 3; }
        else if (i === s.length - 1) { exitScroll(); return; } // lone Esc = exit
        // else: an unrecognized CSI — skip just the ESC and resync on the next byte.
        i += consumed;
        changed = true;
        continue;
      }
      const ch = s[i];
      if (ch === 'k') { scrollOffset -= 1; changed = true; }
      else if (ch === 'j') { scrollOffset += 1; changed = true; }
      else if (ch === 'g') { scrollOffset = 0; changed = true; }
      else if (ch === 'G') { scrollOffset = maxScrollOffset(); changed = true; }
      else if (ch === 'q') { exitScroll(); return; }
      i++;
    }
    if (changed) { clampScrollOffset(); renderScroll(); }
  };

  // Coalesce shell output into throttled bar redraws so a full-screen app or a
  // `clear` can't leave the bar blank; in debug view, coalesce log-tail repaints.
  const timer = setInterval(() => {
    // The pager manages its own render (and owns the alt screen) — the bar/debug
    // redraws must not fire while it's up.
    if (viewMode === 'scroll') return;
    if (viewMode === 'debug') { if (debugDirty) renderDebug(); }
    // A pending alt-screen-exit repaint takes priority: it repaints the shell
    // rows from the emulator's primary viewport (and redraws the bar), so it
    // subsumes a plain barDirty this frame.
    else if (altExitDirty) repaintShellFromFrame();
    else if (barDirty) drawBar();
  }, FRAME_MS);
  timer.unref?.();

  session.onHostData((chunk) => {
    if (!live) return; // pre-live output is captured in the replay; painted on go-live
    // Track the shell app's mouse mode even while the welcome/log view is up, so
    // off-bar mouse passthrough is correct the moment we switch back to the shell.
    const mouseWasOn = appMouseOn();
    scanAppMouse(chunk);
    // Watch for the shell app leaving the alt buffer so we can repair the host's
    // real terminal (which restores its own stale primary) — see scanAppAlt.
    scanAppAlt(chunk);
    // Paint live output ONLY on the shell view: the debug view buffers it in the
    // replay, and the scroll pager owns the (alt) screen — writing shell bytes
    // over it would corrupt the pager. The app-mouse/alt scans above still run in
    // every mode so state stays correct for when we return to the shell.
    if (viewMode === 'shell') {
      writeRaw(chunk);
      barDirty = true;
      // A full-screen app quitting turns mouse OFF, which also kills OUR bar-click
      // reporting; re-assert it after the app's disable bytes have been written.
      if (mouseWasOn && !appMouseOn()) write(MOUSE_ENABLE);
    }
  });
  // A fresh frame (from requestFrame) arrived: paint it into the shell area, but
  // only if we're live and actually on the shell view. This drops the stale/late
  // post-attach replay frame (fired at go-live while viewMode is 'debug') and any
  // frame that lands after the host switched back to the debug view.
  session.onFrame((frame) => {
    // A fresh frame arrived → the daemon answered; cancel any armed old-daemon
    // fallback so it can't also paint from the stale getReplay() cache.
    clearFrameFallback();
    if (!live || viewMode !== 'shell') return;
    paintShellFrame(frame);
  });
  // A scrollback snapshot arrived (from enterScroll's requestScrollback): render
  // it starting at the BOTTOM (newest). Ignored unless we're still in the pager.
  session.onScrollback((lines) => {
    if (viewMode !== 'scroll') return;
    scrollLines = lines;
    scrollOffset = Math.max(0, lines.length - (rows - 1));
    renderScroll();
  });
  session.onViewersChange((n) => { viewers = n; drawBar(); });
  session.onWindowState((state) => {
    windows = state.windows;
    activeIndex = state.activeIndex;
    drawBar();
  });

  // The session captures agent logs into its ring buffer (it owns the
  // OutputHandler sink); we only need to know when a new line arrives so the
  // debug tab repaints its tail while it's the visible surface.
  session.onLog(() => { if (viewMode === 'debug') debugDirty = true; });

  const wasRaw = !!stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  // Window-management commands after a Ctrl-B prefix. Unknown keys are swallowed.
  // `d` detaches (leaving the daemon session running; a no-op for an in-process
  // session that has no detach), `l` opens the logs view; every workspace op
  // returns to (and repaints) the shell view before running, so acting on a
  // window always shows its output.
  const runCommand = (byte: number) => {
    const ch = String.fromCharCode(byte);
    // Detach fires the session's onExit path, which runs restore()+exit below;
    // don't force an exit here that would race it.
    if (ch === 'd') { session.detach?.(); return; }
    if (ch === 'l') { enterDebug(); return; }
    if (ch === '[') { enterScroll(); return; } // tmux-style: Ctrl-B [ = copy mode
    if (ch === 'c') { enterShell(); session.newWindow(); }
    else if (ch === 'n') { enterShell(); session.nextWindow(); }
    else if (ch === 'p') { enterShell(); session.prevWindow(); }
    else if (ch === 'x') { enterShell(); session.closeWindow(activeIndex); }
    else if (ch >= '0' && ch <= '9') {
      // Tabs are labelled 1-based ("1:shell" = index 0), so digit 1..9 selects
      // window 0..8 and 0 selects window 9 (ignored if out of range).
      enterShell();
      const digit = byte - 0x30;
      session.selectWindow(digit === 0 ? 9 : digit - 1);
    }
  };

  // Handle a parsed SGR mouse event. A left-button PRESS on the bar row (rows)
  // is hit-tested against the recorded clickTargets and its action run — never
  // forwarded to the shell. Any other event: if the shell app wants mouse, the
  // ORIGINAL escape bytes are forwarded so vim/htop still get it; otherwise it's
  // swallowed so bash doesn't receive click garbage.
  const handleMouse = (m: MouseEvent, raw: Buffer): void => {
    if (m.row >= rows) { // on (or below) the bar row — the bar owns these
      // button bits: 0/1 = button number, 32 = motion, 64 = wheel, 128 = extra;
      // modifiers (shift/meta/ctrl, bits 2-4) are ignored. Left press = 0.
      if (m.press && (m.button & 0xe3) === 0) {
        for (const t of clickTargets) {
          if (m.col >= t.start && m.col <= t.end) { t.action(); break; }
        }
      }
      return; // never forward bar-row mouse events to the shell
    }
    // Wheel-up on a shell row while the app isn't in mouse mode: the natural
    // gesture to open the scrollback pager. (When the app wants mouse, the wheel
    // still forwards to it below — existing behavior.)
    if (viewMode === 'shell' && m.press && m.button === 64 && !appMouseOn()) {
      enterScroll();
      return;
    }
    if (appMouseOn()) session.write(new Uint8Array(raw)); // shell wants mouse
    // else swallow: bash gets no garbage clicks
  };

  // Ctrl-B prefix state machine: a lone Ctrl-B arms the prefix; the next byte is
  // a command (Ctrl-B again = a literal Ctrl-B to the active window). Well-formed
  // SGR mouse sequences are intercepted (bar click / passthrough / swallow). All
  // other bytes forward to the active window, flushed around each prefix or mouse
  // boundary so ordering across a window switch is preserved.
  let pendingPrefix = false;
  const onInput = (d: Buffer) => {
    // In the pager, keystrokes drive scrolling and are never sent to the shell.
    if (viewMode === 'scroll') { handleScrollInput(d); return; }
    let start = 0;
    for (let i = 0; i < d.length; ) {
      const byte = d[i]!;
      if (pendingPrefix) {
        pendingPrefix = false;
        if (byte === PREFIX) session.write(new Uint8Array([PREFIX]));
        else runCommand(byte);
        i++;
        start = i;
        continue;
      }
      const mouse = matchMouse(d, i);
      if (mouse) {
        if (i > start) session.write(new Uint8Array(d.subarray(start, i)));
        handleMouse(mouse, d.subarray(i, i + mouse.length));
        i += mouse.length;
        start = i;
        continue;
      }
      // PageUp (ESC [ 5 ~) on the live shell view enters the scrollback pager —
      // but only when a full-screen app isn't consuming mouse/alt (it would want
      // PageUp itself); otherwise PageUp forwards to the shell as usual.
      if (viewMode === 'shell' && !appMouseOn() && !appAltOn() &&
          byte === 0x1b && d[i + 1] === 0x5b /* [ */ && d[i + 2] === 0x35 /* 5 */ && d[i + 3] === 0x7e /* ~ */) {
        if (i > start) session.write(new Uint8Array(d.subarray(start, i)));
        enterScroll();
        i += 4;
        start = i;
        continue;
      }
      if (byte === PREFIX) {
        if (i > start) session.write(new Uint8Array(d.subarray(start, i)));
        pendingPrefix = true;
        i++;
        start = i;
        continue;
      }
      i++;
    }
    if (d.length > start) session.write(new Uint8Array(d.subarray(start)));
  };
  stdin.on('data', onInput);

  // Clean resize: drop the scroll region, clear, re-arm the region one row short,
  // resize the shell (which SIGWINCHes it into redrawing itself), then repaint
  // the bar. No banner reprint — the shell's own redraw fills the screen.
  const onResize = () => {
    cols = stdout.columns || cols;
    rows = stdout.rows || rows;
    if (!live) return;
    // In the pager we own the alt screen (no scroll region): resize the shell so
    // its emulator tracks the host size, then re-clamp the offset to the new page
    // height and re-render the pager for the new dimensions.
    if (viewMode === 'scroll') {
      session.resize(cols, Math.max(1, rows - 1));
      clampScrollOffset();
      renderScroll();
      return;
    }
    const shellRows = Math.max(1, rows - 1);
    write('\x1b[r');
    write('\x1b[2J\x1b[H');
    write(`\x1b[1;${shellRows}r`);
    session.resize(cols, shellRows);
    // In debug view the shell won't redraw itself, so re-render the tail for the
    // new size; in shell view the shell's own SIGWINCH redraw fills the screen.
    if (viewMode === 'debug') renderDebug();
    else drawBar();
  };
  stdout.on('resize', onResize);

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    clearInterval(timer);
    clearFrameFallback(); // no stray frame-fallback paint after teardown
    session.dispose(); // release the log sink so any final logs print to stdout normally
    stdin.removeListener('data', onInput);
    stdout.removeListener('resize', onResize);
    if (viewMode === 'scroll') write('\x1b[?1049l'); // leave the pager's alt screen first
    write(MOUSE_DISABLE); // stop SGR mouse reporting we enabled for the bar
    write('\x1b[r'); // reset scroll region
    write('\x1b[2J\x1b[H'); // clear screen + home, so no stale bar/shell is left behind
    write('\x1b[?25h'); // show cursor
    if (stdin.isTTY) { try { stdin.setRawMode(wasRaw); } catch {} }
    stdin.pause();
  };

  session.onExit((code) => {
    restore();
    write('\n');
    output.info('Shared session ended.');
    process.exit(code ?? 0);
  });

  process.on('exit', restore);
  process.on('SIGINT', () => { restore(); process.exit(130); });

  // The session URL is stored on the session (its pinned-header/getUrl source);
  // we react to it arriving. The first URL drives the go-live launch sequence
  // (which lands on the welcome/log view); a later refresh just marks the
  // bar/pinned-header dirty.
  session.onUrl(() => {
    if (live) { // URL refresh after we're already live
      barDirty = true;
      if (viewMode === 'debug') debugDirty = true; // repaint the pinned header
      return;
    }
    cols = stdout.columns || cols;
    rows = stdout.rows || rows;
    const shellRows = Math.max(1, rows - 1);
    write('\x1b[2J\x1b[H');
    write(`\x1b[1;${shellRows}r`); // reserve the bottom row for the bar
    session.resize(cols, shellRows); // shell is authoritative-sized to rows-1
    const goLiveFrame = session.getReplay({ scrollback: 0 });
    scanAppMouse(goLiveFrame); // seed app-mouse state from the shell's screen
    scanAppAlt(goLiveFrame); // seed alt-buffer state (no repaint: we're in debug)
    write(MOUSE_ENABLE); // enable SGR mouse reporting for the clickable bar
    live = true;
    // Start on the welcome/log view (viewMode defaults to 'debug'): the pinned
    // banner + event-log tail. The shell keeps running in the background.
    renderDebug();
  });

  // Connecting screen until the relay hands us the capability URL.
  write('\x1b[2J\x1b[H');
  write(`${BAR_FG}⧉ entangle — connecting…${RESET}`);
}

/**
 * Raw pass-through: mirror the shell byte-for-byte and forward keystrokes, with
 * no status bar. Used when the terminal is too small for a bar (or not a TTY).
 */
function attachRawTerminal(session: HostSession, output: OutputHandler): void {
  const stdin = process.stdin;
  const stdout = process.stdout;

  // No status bar and no debug tab here, so there's nowhere to surface captured
  // logs — release the session's log sink (if it owns one) so agent logs print
  // to stdout as they did before this UI existed (the bar path keeps the sink
  // for its debug tab). NOT dispose(): a daemon-backed session's dispose ends
  // its socket, which would kill the attach right here.
  session.releaseLogSink?.();

  const initial = session.getReplay();
  if (initial.length > 0) { try { stdout.write(Buffer.from(initial)); } catch {} }
  // A daemon-backed session delivers its post-attach replay (and any refreshed
  // frames) asynchronously via onFrame — paint those too, so a raw reattach
  // shows the window's current screen instead of starting blank.
  session.onFrame((frame) => { try { stdout.write(Buffer.from(frame)); } catch {} });

  session.onHostData((chunk) => { try { stdout.write(chunk); } catch {} });

  const wasRaw = !!stdin.isRaw;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();

  // A daemon-backed session gets a detach key even without the bar: Ctrl-B d
  // detaches (Ctrl-B Ctrl-B sends a literal Ctrl-B; any other command byte is
  // swallowed, like the bar's prefix), otherwise a raw attach could only be
  // left by killing the terminal. Interactive TTYs only — piped stdin stays
  // pure byte-for-byte passthrough.
  const canDetach = !!stdin.isTTY && typeof session.detach === 'function';
  let pendingPrefix = false;
  const onInput = (d: Buffer) => {
    if (!canDetach) { session.write(new Uint8Array(d)); return; }
    let start = 0;
    for (let i = 0; i < d.length; i++) {
      const byte = d[i]!;
      if (pendingPrefix) {
        pendingPrefix = false;
        if (byte === PREFIX) session.write(new Uint8Array([PREFIX]));
        else if (byte === 0x64 /* d */) { session.detach!(); return; }
        start = i + 1;
        continue;
      }
      if (byte === PREFIX) {
        if (i > start) session.write(new Uint8Array(d.subarray(start, i)));
        pendingPrefix = true;
        start = i + 1;
      }
    }
    if (d.length > start) session.write(new Uint8Array(d.subarray(start)));
  };
  stdin.on('data', onInput);

  const onResize = () => session.resize(stdout.columns || 80, stdout.rows || 24);
  stdout.on('resize', onResize);

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    session.dispose(); // release the log sink so any final logs print to stdout normally
    stdin.removeListener('data', onInput);
    stdout.removeListener('resize', onResize);
    if (stdin.isTTY) { try { stdin.setRawMode(wasRaw); } catch {} }
    stdin.pause();
  };

  session.onExit((code) => {
    restore();
    output.info(`Shared session ended (code=${code ?? 0}).`);
    process.exit(code ?? 0);
  });

  process.on('exit', restore);

  // The relay hands us the capability URL after attach; print it once it arrives.
  session.onUrl((link) => {
    output.info(`⧉ entangle session shared — open to collaborate:\n  ${link}\n`);
  });
}
