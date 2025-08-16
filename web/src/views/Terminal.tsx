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
  const [status, setStatus] = useState<'connecting' | 'authenticating' | 'password' | 'ready' | 'error'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string>('');
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [password, setPassword] = useState<string>('');
  const [showCwdDialog, setShowCwdDialog] = useState(false);
  
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string>(Math.random().toString(36).substr(2, 9));
  const keysRef = useRef<any>(null);
  const countersRef = useRef<any>(null);
  
  const connect = async (workingDir?: string) => {
    setShowCwdDialog(false);
    setStatus('connecting');
    
    try {
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
      let passwordVerified = false;
      let nonceC: string | undefined;
      
      ws.onopen = async () => {
        setStatus('authenticating');
        
        // Send AUTH1
        const nonceB = Math.random().toString(36);
        const nonceBHex = Array.from(new TextEncoder().encode(nonceB)).map(b => b.toString(16).padStart(2, '0')).join('');
        const auth1Data = new TextEncoder().encode('hello' + capability.capId + nonceBHex);
        const auth1Hmac = computeHmac(keys.K_auth, auth1Data);
        
        // console.log('[TerminalView] AUTH1 details:', {
        //   capId: capability.capId,
        //   nonceB: nonceBHex,
        //   auth1DataString: 'hello' + capability.capId + nonceBHex,
        //   hmacHex: Array.from(auth1Hmac).map(b => b.toString(16).padStart(2, '0')).join('')
        // });
        
        // Combine HMAC and nonceB for AUTH1 payload
        // Important: send the same representation used in HMAC (hex)
        const nonceBBytes = new TextEncoder().encode(nonceBHex);
        const auth1Payload = new Uint8Array(32 + nonceBBytes.length);
        auth1Payload.set(auth1Hmac, 0);
        auth1Payload.set(nonceBBytes, 32);
        
        const auth1Frame = encodeFrame(FrameType.AUTH1, auth1Payload);
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
              const requiresPassword = auth2.requiresPassword || false;
              
              // Send AUTH3
              const auth3Data = new TextEncoder().encode('ready' + nonceC);
              const auth3Hmac = computeHmac(keys.K_auth, auth3Data);
              const auth3Frame = encodeFrame(FrameType.AUTH3, auth3Hmac);
              ws.send(auth3Frame);
              
              authenticated = true;
              
              // Check if password is required
              if (requiresPassword) {
                setStatus('password');
                
                // Check if password is in URL fragment
                const hashParams = new URLSearchParams(window.location.hash.slice(1));
                const urlPassword = hashParams.get('PW');
                
                if (urlPassword) {
                  // Send password automatically
                  const pwMsg = {
                    ctr: counters.outgoing.next(),
                    msg: { password: urlPassword }
                  };
                  
                  const pwEncrypted = aeadEncrypt(keys.K_enc, FrameType.AUTH_PW, pwMsg.ctr, pwMsg.msg);
                  const pwFrame = encodeFrame(FrameType.AUTH_PW, encode(pwEncrypted));
                  ws.send(pwFrame);
                } else {
                  // Show password dialog
                  setShowPasswordDialog(true);
                  return;
                }
              } else {
                passwordVerified = true;
                setStatus('ready');
              }
              
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
              
            } else if (frame.type === FrameType.AUTH_PW && authenticated && !passwordVerified) {
              // Handle password response
              const encrypted = decode(frame.payload) as any;
              const decrypted = aeadDecrypt(keys.K_enc, FrameType.AUTH_PW, encrypted.nonce, encrypted.cipher);
              counters.incoming.validate(decrypted.ctr);
              
              const pwResponse = decrypted.msg as { ok: boolean };
              if (pwResponse.ok) {
                passwordVerified = true;
                setStatus('ready');
                setShowPasswordDialog(false);
                
                // Now initialize terminal
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
              } else {
                setError('Invalid password');
                setStatus('error');
                ws.close();
              }
            } else if (frame.type === FrameType.TTY_DATA && authenticated && passwordVerified) {
              // Handle TTY data
              const encrypted = decode(frame.payload) as any;
              const decrypted = aeadDecrypt(keys.K_enc, FrameType.TTY_DATA, encrypted.nonce, encrypted.cipher);
              counters.incoming.validate(decrypted.ctr);
              
              const msg = decrypted.msg as any;
              if (msg.sessionId === sessionIdRef.current && termRef.current) {
                termRef.current.write(new Uint8Array(msg.chunk));
              }
              
            } else if (frame.type === FrameType.TTY_EXIT && authenticated && passwordVerified) {
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

  // Auto-connect on mount if the CWD dialog is hidden
  useEffect(() => {
    if (!showCwdDialog) {
      // No working directory prompt; start session immediately
      // Intentionally not passing a cwd so server uses default
      connect();
    }
    // Run only on initial mount to avoid double-connects
    // when the dialog toggles from true -> false via user action
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  
  const sendPassword = () => {
    if (!wsRef.current || !password || !keysRef.current || !countersRef.current) return;
    
    const pwMsg = {
      ctr: countersRef.current.outgoing.next(),
      msg: { password }
    };
    
    const pwEncrypted = aeadEncrypt(keysRef.current.K_enc, FrameType.AUTH_PW, pwMsg.ctr, pwMsg.msg);
    const pwFrame = encodeFrame(FrameType.AUTH_PW, encode(pwEncrypted));
    wsRef.current.send(pwFrame);
  };
  
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
  
  if (showPasswordDialog) {
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
              if (e.key === 'Enter') {
                sendPassword();
              }
            }}
          />
          <div className="buttons">
            <button onClick={sendPassword}>Submit</button>
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
