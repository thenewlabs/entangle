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
  const [command, setCommand] = useState('');
  const [availableTools, setAvailableTools] = useState<string[]>([]);
  
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
    
    // For now, we'll infer tools from the capability URL pattern
    // In a full implementation, this could be fetched from the server
    // or embedded in the capability metadata
    setAvailableTools(['claude', 'ls', 'cat', 'echo']);
    
    relayClient.connect().catch(console.error);
    
    return () => {
      relayClient.disconnect();
      term.dispose();
    };
  }, [capability.namespace, capability.capId, capability.S]);
  
  const handleRun = async () => {
    if (!client || !connected || running || !command.trim()) return;
    
    try {
      const parts = command.trim().split(' ');
      const tool = parts[0];
      const argv = parts.slice(1);
      
      if (!tool) {
        console.error('No tool specified');
        return;
      }
      
      setRunning(true);
      await client.run(tool, argv, cwd || undefined);
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
        {availableTools.length > 0 && (
          <div className="tools-hint">
            Available tools: {availableTools.join(', ')}
          </div>
        )}
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
            placeholder="Command (e.g., claude --help, ls -la)"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !running) {
                handleRun();
              }
            }}
            disabled={running}
            style={{ flex: 1 }}
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