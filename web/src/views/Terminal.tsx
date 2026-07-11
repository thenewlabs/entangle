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

  const [status, setStatus] = useState<'connecting' | 'ready' | 'error'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [needPassword, setNeedPassword] = useState(false);
  const [password, setPassword] = useState('');

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
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(terminalRef.current);
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

      const handleResize = () => {
        fitAddonRef.current?.fit();
        child.resize(term.cols, term.rows);
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
    return () => {
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
