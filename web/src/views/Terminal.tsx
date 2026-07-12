import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

interface TerminalViewProps {
  capability: {
    capId: string;
    S: string;
  };
}

// Pure UI over the window.entangle PTY client; all crypto/protocol lives in
// window-entangle-spawn.ts.
export function TerminalView(_props: TerminalViewProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const childRef = useRef<any>(null);
  const startedRef = useRef(false);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [status, setStatus] = useState<'connecting' | 'ready' | 'error'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [needPassword, setNeedPassword] = useState(false);
  const [password, setPassword] = useState('');
  // Shared-workspace window state that drives the tmux-style tab bar. The server
  // broadcasts window-state over WINDOW_CTL; the single xterm below is repainted
  // by the server on a switch, so we only mirror the tabs here.
  const [windows, setWindows] = useState<{ id: string; title: string }[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  const start = () => {
    if (!terminalRef.current) return;
    const entangle = (window as any).entangle;
    if (!entangle?.openTerminal) {
      setError('Entangle client not ready (missing capability in URL)');
      setStatus('error');
      return;
    }

    if (!termRef.current) {
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
        // Generous, explicit scrollback so the viewer can scroll back through
        // history accumulated from the live stream (default is only 1000 lines).
        scrollback: 5000,
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(terminalRef.current);
      // Fit synchronously so the initial openTerminal() below gets the real
      // cols/rows. The tab bar isn't mounted yet at this point (it renders only
      // once status is 'ready' and windows arrive), so there's no pre-layout
      // size to correct for here; window-resize re-fits handle later changes.
      fitAddon.fit();
      termRef.current = term;
      fitAddonRef.current = fitAddon;
    }

    const term = termRef.current;
    const child = entangle.openTerminal({ cols: term.cols, rows: term.rows });
    childRef.current = child;

    child.on('opened', () => {
      setStatus('ready');
      setNeedPassword(false);

      term.onData((data: string) => child.stdin.write(data));

      // On resize we re-fit xterm to the new size and tell the server the new
      // dimensions. The server replies with a host-authoritative in-place
      // repaint (clear viewport + serialized active-window screen, NO scrollback
      // erase), so the visible screen is redrawn correctly for the new size.
      // We deliberately do NOT term.reset() here: reset wipes xterm's scrollback,
      // and the viewer must keep the history it has accumulated from the live
      // stream. xterm re-wraps its own buffer on fit; the incoming server repaint
      // overwrites the viewport, so we let the stale re-wrap stand for the brief
      // moment before it arrives rather than clear() it — the flash is negligible
      // and clearing risks a visible blank gap. Debounced so a drag-resize
      // doesn't spam fit/resize; a single fit+resize runs once it settles.
      const resync = () => {
        fitAddonRef.current?.fit();
        child.resize(term.cols, term.rows);
      };
      const handleResize = () => {
        if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = setTimeout(resync, 120);
      };
      window.addEventListener('resize', handleResize);
      (child as any).__onResize = handleResize;
    });

    child.on('data', (chunk: Uint8Array) => term.write(chunk));

    child.on('exit', (code: number | null) => {
      term.write(`\r\n[Process exited with code ${code ?? 'null'}]\r\n`);
    });

    child.on('error', (message: string) => {
      if (/password/i.test(message)) {
        setNeedPassword(true);
        setStatus('connecting');
      } else {
        setError(message);
        setStatus('error');
      }
    });
  };

  const submitPassword = () => {
    if (!password) return;
    // The client reads window.entangle.password during (re)auth.
    (window as any).entangle = (window as any).entangle || {};
    (window as any).entangle.password = password;
    start();
  };

  useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true;
      start();
    }
    // Subscribe to window-state broadcasts to drive the tab bar. onWindowState
    // replays the last known state immediately, so a late mount still populates.
    const entangle = (window as any).entangle;
    const unsub: (() => void) | undefined = entangle?.onWindowState?.((state: {
      windows: { id: string; title: string }[];
      activeIndex: number;
    }) => {
      setWindows(state.windows ?? []);
      setActiveIndex(state.activeIndex ?? 0);
    });
    return () => {
      unsub?.();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      const child = childRef.current;
      if (child?.__onResize) window.removeEventListener('resize', child.__onResize);
      childRef.current?.kill?.('SIGHUP');
      termRef.current?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (needPassword) {
    return (
      <div className="terminal-view">
        <div className="cwd-dialog">
          <h2>Password Required</h2>
          <p>This agent requires a password:</p>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitPassword();
            }}
          />
          <div className="buttons">
            <button onClick={submitPassword}>Submit</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-view">
      {status === 'error' && <div className="error-banner">Error: {error}</div>}
      {status === 'connecting' && <div className="status-banner">Connecting...</div>}
      {status === 'ready' && windows.length > 0 && (
        <div className="window-tabbar" role="tablist" aria-label="Windows">
          {windows.map((w, i) => (
            <div
              key={w.id}
              className={`window-tab${i === activeIndex ? ' active' : ''}`}
              role="tab"
              aria-selected={i === activeIndex}
              title={w.title || `Window ${i + 1}`}
              onClick={() => (window as any).entangle?.selectWindow?.(i)}
            >
              <span className="window-tab-label">{w.title || `${i + 1}`}</span>
              {windows.length > 1 && (
                <button
                  type="button"
                  className="window-tab-close"
                  aria-label={`Close ${w.title || `window ${i + 1}`}`}
                  title="Close window"
                  onClick={(e) => {
                    e.stopPropagation();
                    (window as any).entangle?.closeWindow?.(i);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="window-tab-new"
            aria-label="New window"
            title="New window"
            onClick={() => (window as any).entangle?.newWindow?.()}
          >
            +
          </button>
        </div>
      )}
      <div className="terminal-stage">
        {status === 'ready' && (
          <span
            className="shared-badge"
            title="This is a shared terminal. Others may be watching and typing along with you."
          >
            <span className="shared-badge-glyph" aria-hidden="true">⧉</span>
            Shared session
          </span>
        )}
        <div ref={terminalRef} className="terminal-container" />
      </div>
    </div>
  );
}
