import { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { deriveKeys, extractSaltFromCapId, aeadEncrypt, aeadDecrypt, computeHmac } from '@sunpix/entangle-crypto';
import { FrameType, FrameReader, encodeFrame } from '@sunpix/entangle-protocol';
import { BidirectionalCounters } from '@sunpix/entangle-utils/browser';
import { encode, decode } from 'cborg';
import 'xterm/css/xterm.css';

interface TerminalViewProps {
  capability: {
    capId: string;
    S: string;
  };
}

export function TerminalView({ capability }: TerminalViewProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'authenticating' | 'ready' | 'error'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string>('');
  const [showCwdDialog, setShowCwdDialog] = useState(true);
  
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string>(Math.random().toString(36).substr(2, 9));
  
  const connect = async (workingDir?: string) => {
    setShowCwdDialog(false);
    setStatus('connecting');
    
    try {
      // Derive keys
      const saltCap = extractSaltFromCapId(capability.capId);
      const keys = await deriveKeys(capability.S, saltCap);
      
      // Connect to WebSocket
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/relay/${capability.capId}`;
      
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      
      const reader = new FrameReader();
      const counters = new BidirectionalCounters();
      let authenticated = false;
      let nonceC: string | undefined;
      
      ws.onopen = async () => {
        setStatus('authenticating');
        
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
              setStatus('ready');
              
              // Initialize terminal
              if (terminalRef.current && !termRef.current) {
                const term = new Terminal({
                  cursorBlink: true,
                  fontSize: 14,
                  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
                  theme: {
                    background: '#1e1e1e',
                    foreground: '#d4d4d4',
                  },
                });
                
                const fitAddon = new FitAddon();
                term.loadAddon(fitAddon);
                
                term.open(terminalRef.current);
                fitAddon.fit();
                
                termRef.current = term;
                fitAddonRef.current = fitAddon;
                
                // Send TTY_OPEN
                const ttyOpen = {
                  sessionId: sessionIdRef.current,
                  cwd: workingDir,
                  cols: term.cols,
                  rows: term.rows,
                };
                
                const encrypted = aeadEncrypt(keys.K_enc, FrameType.TTY_OPEN, counters.outgoing.next(), ttyOpen);
                const frame = encodeFrame(FrameType.TTY_OPEN, encode(encrypted));
                ws.send(frame);
                
                // Handle terminal input
                term.onData((data) => {
                  const ttyData = {
                    sessionId: sessionIdRef.current,
                    chunk: new TextEncoder().encode(data),
                  };
                  
                  const encrypted = aeadEncrypt(keys.K_enc, FrameType.TTY_DATA, counters.outgoing.next(), ttyData);
                  const frame = encodeFrame(FrameType.TTY_DATA, encode(encrypted));
                  ws.send(frame);
                });
                
                // Handle resize
                const handleResize = () => {
                  if (fitAddonRef.current && termRef.current) {
                    fitAddonRef.current.fit();
                    
                    const resize = {
                      sessionId: sessionIdRef.current,
                      cols: termRef.current.cols,
                      rows: termRef.current.rows,
                    };
                    
                    const encrypted = aeadEncrypt(keys.K_enc, FrameType.TTY_RESIZE, counters.outgoing.next(), resize);
                    const frame = encodeFrame(FrameType.TTY_RESIZE, encode(encrypted));
                    ws.send(frame);
                  }
                };
                
                window.addEventListener('resize', handleResize);
                
                // Store cleanup function
                const cleanup = () => {
                  window.removeEventListener('resize', handleResize);
                };
                ws.onclose = () => {
                  cleanup();
                  if (termRef.current) {
                    termRef.current.write('\r\n[Disconnected]\r\n');
                  }
                };
              }
              
            } else if (frame.type === FrameType.TTY_DATA && authenticated) {
              // Handle TTY data
              const encrypted = decode(frame.payload) as any;
              const decrypted = aeadDecrypt(keys.K_enc, FrameType.TTY_DATA, encrypted.nonce, encrypted.cipher);
              counters.incoming.validate(decrypted.ctr);
              
              const msg = decrypted.msg as any;
              if (msg.sessionId === sessionIdRef.current && termRef.current) {
                termRef.current.write(new Uint8Array(msg.chunk));
              }
              
            } else if (frame.type === FrameType.TTY_EXIT && authenticated) {
              // Handle TTY exit
              const encrypted = decode(frame.payload) as any;
              const decrypted = aeadDecrypt(keys.K_enc, FrameType.TTY_EXIT, encrypted.nonce, encrypted.cipher);
              counters.incoming.validate(decrypted.ctr);
              
              const msg = decrypted.msg as any;
              if (msg.sessionId === sessionIdRef.current) {
                if (termRef.current) {
                  termRef.current.write('\r\n[Process exited with code ' + (msg.code ?? 'null') + ']\r\n');
                }
                ws.close();
              }
              
            } else if (frame.type === FrameType.ERROR) {
              // Handle error
              const encrypted = decode(frame.payload) as any;
              const decrypted = aeadDecrypt(keys.K_enc, FrameType.ERROR, encrypted.nonce, encrypted.cipher);
              const error = decrypted.msg;
              setError(`${error.code}: ${error.detail || 'Unknown error'}`);
              setStatus('error');
            }
          } catch (err) {
            console.error('Frame handling error:', err);
          }
        }
      };
      
      ws.onerror = (event) => {
        console.error('WebSocket error:', event);
        setError('Connection error');
        setStatus('error');
      };
      
      ws.onclose = () => {
        if (termRef.current) {
          termRef.current.write('\r\n[Disconnected]\r\n');
        }
      };
      
    } catch (err: any) {
      setError(err.message || 'Failed to connect');
      setStatus('error');
    }
  };
  
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (termRef.current) {
        termRef.current.dispose();
      }
    };
  }, []);
  
  if (showCwdDialog) {
    return (
      <div className="terminal-view">
        <div className="cwd-dialog">
          <h2>Terminal Session</h2>
          <p>Working Directory (optional):</p>
          <input
            type="text"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/home/user"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                connect(cwd || undefined);
              }
            }}
          />
          <div className="buttons">
            <button onClick={() => connect(cwd || undefined)}>Connect</button>
          </div>
        </div>
      </div>
    );
  }
  
  return (
    <div className="terminal-view">
      {status === 'error' && (
        <div className="error-banner">
          Error: {error}
        </div>
      )}
      {(status === 'connecting' || status === 'authenticating') && (
        <div className="status-banner">
          {status === 'connecting' ? 'Connecting...' : 'Authenticating...'}
        </div>
      )}
      <div ref={terminalRef} className="terminal-container" />
    </div>
  );
}