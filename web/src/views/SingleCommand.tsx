import { useState, useRef } from 'react';

interface SingleCommandViewProps {
  capability: {
    capId: string;
    S: string;
  };
}

// The window.entangle client (window-entangle-spawn.ts) owns all crypto and the
// wire protocol; this view is pure UI over it.
export function SingleCommandView(_props: SingleCommandViewProps) {
  const [cwd, setCwd] = useState('');
  const [commandLine, setCommandLine] = useState('');
  const [stdout, setStdout] = useState('');
  const [stderr, setStderr] = useState('');
  const [running, setRunning] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needPassword, setNeedPassword] = useState(false);
  const [password, setPassword] = useState('');

  const childRef = useRef<any>(null);

  const runCommand = () => {
    if (!commandLine.trim()) return;

    setStdout('');
    setStderr('');
    setExitCode(null);
    setError(null);
    setNeedPassword(false);

    const argv = parseCommandLine(commandLine);
    if (argv.length === 0) {
      setError('No command provided');
      return;
    }

    const entangle = (window as any).entangle;
    if (!entangle?.spawn) {
      setError('Entangle client not ready (missing capability in URL)');
      return;
    }

    setRunning(true);
    const decoder = new TextDecoder();
    try {
      const child = entangle.spawn(argv[0], argv.slice(1), cwd ? { cwd } : {});
      childRef.current = child;

      child.on('data', (chunk: Uint8Array, channel?: 'stdout' | 'stderr') => {
        const text = decoder.decode(chunk);
        if (channel === 'stderr') setStderr((prev) => prev + text);
        else setStdout((prev) => prev + text);
      });
      child.on('exit', (code: number | null) => {
        setExitCode(code ?? -1);
        setRunning(false);
      });
      child.on('error', (message: string) => {
        // A password-related error means the agent is password-gated and we
        // haven't verified yet — prompt instead of surfacing a raw error.
        if (/password/i.test(message)) {
          setNeedPassword(true);
        } else {
          setError(message);
        }
        setRunning(false);
      });
    } catch (err: any) {
      setError(err?.message || 'Failed to run command');
      setRunning(false);
    }
  };

  const submitPassword = () => {
    if (!password) return;
    // The client reads window.entangle.password during (re)auth.
    (window as any).entangle = (window as any).entangle || {};
    (window as any).entangle.password = password;
    setNeedPassword(false);
    runCommand();
  };

  const abortCommand = () => {
    childRef.current?.kill('SIGTERM');
  };

  if (needPassword) {
    return (
      <div className="single-command-view">
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
    <div className="single-command-view">
      <div className="command-form">
        <h2>Run Command</h2>

        <div className="form-group">
          <label>Working Directory (optional):</label>
          <input
            type="text"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/home/user"
            disabled={running}
          />
        </div>

        <div className="form-group">
          <label>Command:</label>
          <input
            type="text"
            value={commandLine}
            onChange={(e) => setCommandLine(e.target.value)}
            placeholder="ls -la"
            disabled={running}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !running) {
                runCommand();
              }
            }}
          />
        </div>

        <div className="buttons">
          <button onClick={runCommand} disabled={running || !commandLine.trim()}>
            Run
          </button>
          <button onClick={abortCommand} disabled={!running}>
            Abort
          </button>
        </div>

        {error && <div className="error-message">{error}</div>}
      </div>

      <div className="output-section">
        {stdout && (
          <div className="output-pane">
            <h3>Standard Output</h3>
            <pre>{stdout}</pre>
          </div>
        )}

        {stderr && (
          <div className="output-pane stderr">
            <h3>Standard Error</h3>
            <pre>{stderr}</pre>
          </div>
        )}

        {exitCode !== null && (
          <div className={`exit-code ${exitCode === 0 ? 'success' : 'error'}`}>
            Process exited with code: {exitCode}
          </div>
        )}
      </div>
    </div>
  );
}

// Simple command line parser (handles quotes and escapes)
function parseCommandLine(cmdline: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';
  let escaped = false;

  for (let i = 0; i < cmdline.length; i++) {
    const char = cmdline[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (inQuotes) {
      if (char === quoteChar) {
        inQuotes = false;
        quoteChar = '';
      } else {
        current += char;
      }
    } else {
      if (char === '"' || char === "'") {
        inQuotes = true;
        quoteChar = char;
      } else if (char === ' ' || char === '\t') {
        if (current) {
          args.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }
  }

  if (current) {
    args.push(current);
  }

  return args;
}
