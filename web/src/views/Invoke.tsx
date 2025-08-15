import { useState, useRef, useEffect } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { RelayClient } from '../api/relay';

interface Props {
  capability: {
    namespace: string;
    capId: string;
    S: string;
  };
}

export function InvokeView({ capability }: Props) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const [_terminal, setTerminal] = useState<Terminal | null>(null);
  const [client, setClient] = useState<RelayClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [cwd, setCwd] = useState('');
  const [args, setArgs] = useState('');
  
  useEffect(() => {
    if (!terminalRef.current) return;
    
    const term = new Terminal({
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
      },
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 14,
    });
    
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();
    
    setTerminal(term);
    
    const relayClient = new RelayClient(
      capability.namespace,
      capability.capId,
      capability.S,
      term
    );
    
    relayClient.onConnect = () => setConnected(true);
    relayClient.onDisconnect = () => {
      setConnected(false);
      setRunning(false);
    };
    relayClient.onExit = () => setRunning(false);
    
    setClient(relayClient);
    
    relayClient.connect().catch(console.error);
    
    return () => {
      relayClient.disconnect();
      term.dispose();
    };
  }, [capability]);
  
  const handleRun = async () => {
    if (!client || !connected || running) return;
    
    try {
      const argv = args.split(' ').filter(Boolean);
      setRunning(true);
      await client.run('claude', argv, cwd || undefined);
    } catch (error) {
      console.error('Failed to run:', error);
      setRunning(false);
    }
  };
  
  const handleAbort = () => {
    if (!client || !running) return;
    client.abort();
  };
  
  return (
    <div className="app">
      <div className="header">
        <h1>Entangle Terminal</h1>
        <div className="controls">
          <input
            type="text"
            placeholder="Working directory (optional)"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            disabled={running}
          />
          <input
            type="text"
            placeholder="Arguments"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            disabled={running}
          />
          {running ? (
            <button onClick={handleAbort}>Abort</button>
          ) : (
            <button onClick={handleRun} disabled={!connected}>
              Run
            </button>
          )}
        </div>
      </div>
      
      <div className="terminal-container" ref={terminalRef} />
      
      <div className={`status ${connected ? 'connected' : 'error'}`}>
        {connected ? 'Connected' : 'Disconnected'}
        {running && ' - Running...'}
      </div>
    </div>
  );
}