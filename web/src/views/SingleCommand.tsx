import { useState, useRef } from 'react';
import { deriveKeys, extractSaltFromCapId, aeadEncrypt, aeadDecrypt, computeHmac } from '@sunpix/entangle-crypto';
import { FrameType, FrameReader, encodeFrame } from '@sunpix/entangle-protocol';
import { BidirectionalCounters } from '@sunpix/entangle-utils/browser';
import { encode, decode } from 'cborg';

interface SingleCommandViewProps {
  capability: {
    capId: string;
    S: string;
  };
}

export function SingleCommandView({ capability }: SingleCommandViewProps) {
  const [cwd, setCwd] = useState('');
  const [commandLine, setCommandLine] = useState('');
  const [stdout, setStdout] = useState('');
  const [stderr, setStderr] = useState('');
  const [running, setRunning] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const commandIdRef = useRef<string>('');
  const keysRef = useRef<any>(null);
  const countersRef = useRef<BidirectionalCounters | null>(null);
  
  const runCommand = async () => {
    if (!commandLine.trim()) return;
    
    setStdout('');
    setStderr('');
    setExitCode(null);
    setError(null);
    setRunning(true);
    
    try {
      // Parse command line into argv
      const argv = parseCommandLine(commandLine);
      if (argv.length === 0) {
        throw new Error('No command provided');
      }
      
      // Generate command ID
      commandIdRef.current = Math.random().toString(36).substr(2, 9);
      
      // Derive keys
      const saltCap = extractSaltFromCapId(capability.capId);
      const keys = await deriveKeys(capability.S, saltCap);
      keysRef.current = keys;
      
      // Connect to WebSocket
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/relay/${capability.capId}`;
      
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      
      const reader = new FrameReader();
      const counters = new BidirectionalCounters();
      countersRef.current = counters;
      
      let authenticated = false;
      let nonceC: string | undefined;
      
      ws.onopen = async () => {
        // Send AUTH1
        const auth1Data = new TextEncoder().encode('hello' + capability.capId + Math.random().toString(36));
        const auth1Hmac = computeHmac(keys.K_auth, auth1Data);
        const auth1Frame = encodeFrame(FrameType.AUTH1, auth1Hmac);
        ws.send(auth1Frame);
      };
      
      ws.onmessage = async (event) => {
        const data = await event.data.arrayBuffer();
        const frames = reader.push(new Uint8Array(data));
        
        for (const frame of frames) {
          try {
            if (frame.type === FrameType.AUTH2 && !authenticated) {
              // Handle AUTH2
              const encrypted = decode(frame.payload) as any;
              const decrypted = aeadDecrypt(keys.K_enc, FrameType.AUTH2, encrypted.nonce, encrypted.cipher);
              const auth2 = decrypted.msg;
              
              nonceC = auth2.nonceC;
              
              // Send AUTH3
              const auth3Data = new TextEncoder().encode('ready' + nonceC);
              const auth3Hmac = computeHmac(keys.K_auth, auth3Data);
              const auth3Frame = encodeFrame(FrameType.AUTH3, auth3Hmac);
              ws.send(auth3Frame);
              
              authenticated = true;
              
              // Send RUN command
              const runMsg = {
                commandId: commandIdRef.current,
                argv,
                cwd: cwd || undefined,
              };
              
              const runEncrypted = aeadEncrypt(keys.K_enc, FrameType.RUN, counters.outgoing.next(), runMsg);
              const runFrame = encodeFrame(FrameType.RUN, encode(runEncrypted));
              ws.send(runFrame);
              
            } else if (frame.type === FrameType.STDOUT && authenticated) {
              // Handle stdout
              const encrypted = decode(frame.payload) as any;
              const decrypted = aeadDecrypt(keys.K_enc, FrameType.STDOUT, encrypted.nonce, encrypted.cipher);
              counters.incoming.validate(decrypted.ctr);
              
              const msg = decrypted.msg as any;
              if (msg.commandId === commandIdRef.current) {
                const text = new TextDecoder().decode(new Uint8Array(msg.chunk));
                setStdout(prev => prev + text);
              }
              
            } else if (frame.type === FrameType.STDERR && authenticated) {
              // Handle stderr
              const encrypted = decode(frame.payload) as any;
              const decrypted = aeadDecrypt(keys.K_enc, FrameType.STDERR, encrypted.nonce, encrypted.cipher);
              counters.incoming.validate(decrypted.ctr);
              
              const msg = decrypted.msg as any;
              if (msg.commandId === commandIdRef.current) {
                const text = new TextDecoder().decode(new Uint8Array(msg.chunk));
                setStderr(prev => prev + text);
              }
              
            } else if (frame.type === FrameType.EXIT && authenticated) {
              // Handle exit
              const encrypted = decode(frame.payload) as any;
              const decrypted = aeadDecrypt(keys.K_enc, FrameType.EXIT, encrypted.nonce, encrypted.cipher);
              counters.incoming.validate(decrypted.ctr);
              
              const msg = decrypted.msg as any;
              if (msg.commandId === commandIdRef.current) {
                setExitCode(msg.code ?? -1);
                setRunning(false);
                ws.close();
              }
              
            } else if (frame.type === FrameType.ERROR) {
              // Handle error
              const encrypted = decode(frame.payload) as any;
              const decrypted = aeadDecrypt(keys.K_enc, FrameType.ERROR, encrypted.nonce, encrypted.cipher);
              const error = decrypted.msg;
              setError(`${error.code}: ${error.detail || 'Unknown error'}`);
              setRunning(false);
              ws.close();
            }
          } catch (err) {
            console.error('Frame handling error:', err);
          }
        }
      };
      
      ws.onerror = (event) => {
        console.error('WebSocket error:', event);
        setError('Connection error');
        setRunning(false);
      };
      
      ws.onclose = () => {
        setRunning(false);
      };
      
    } catch (err: any) {
      setError(err.message || 'Failed to run command');
      setRunning(false);
    }
  };
  
  const abortCommand = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && keysRef.current && countersRef.current) {
      const abortMsg = {
        commandId: commandIdRef.current,
        reason: 'user abort',
      };
      
      const encrypted = aeadEncrypt(keysRef.current.K_enc, FrameType.ABORT, countersRef.current.outgoing.next(), abortMsg);
      const frame = encodeFrame(FrameType.ABORT, encode(encrypted));
      wsRef.current.send(frame);
    }
  };
  
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
        
        {error && (
          <div className="error-message">
            {error}
          </div>
        )}
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