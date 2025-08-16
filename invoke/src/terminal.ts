import WebSocket from 'ws';
import { deriveKeys, extractSaltFromCapId, aeadEncrypt, aeadDecrypt, computeHmac } from '@sunpix/entangle-crypto';
import { FrameType, FrameReader, encodeFrame, TtyDataMessage, TtyExitMessage } from '@sunpix/entangle-protocol';
import { OutputHandler, parseOutputMode, BidirectionalCounters } from '@sunpix/entangle-utils';
import { encode, decode } from 'cborg';
// import * as readline from 'readline';

const output = new OutputHandler({ mode: parseOutputMode(process.env.OUTPUT_MODE || 'text') });

export async function openTerminal(
  wsUrl: string, 
  S: string, 
  options: { cwd?: string | undefined; cols?: number | undefined; rows?: number | undefined },
  password?: string
): Promise<void> {
  const { cwd, cols = 80, rows = 24 } = options;
  
  // Extract capId from URL
  const urlParts = wsUrl.split('/');
  const capId = urlParts[urlParts.length - 1];
  
  // Derive keys
  const saltCap = extractSaltFromCapId(capId!);
  const keys = await deriveKeys(S, saltCap);
  
  // Connect to relay
  const ws = new WebSocket(wsUrl);
  const reader = new FrameReader();
  const counters = new BidirectionalCounters();
  
  // Session ID for this terminal session
  const sessionId = Math.random().toString(36).substr(2, 9);
  
  return new Promise((resolve, reject) => {
    ws.on('open', async () => {
      output.info('Connected to relay');
      
      try {
        // Send AUTH1
        const nonceB = Math.random().toString(36).substr(2);
        const auth1Data = new TextEncoder().encode('hello' + capId + nonceB);
        const auth1Hmac = computeHmac(keys.K_auth, auth1Data);
        
        // Send HMAC + nonceB
        const nonceBBytes = new TextEncoder().encode(nonceB);
        const auth1Payload = new Uint8Array(32 + nonceBBytes.length);
        auth1Payload.set(auth1Hmac, 0);
        auth1Payload.set(nonceBBytes, 32);
        
        const auth1Frame = encodeFrame(FrameType.AUTH1, auth1Payload);
        ws.send(auth1Frame);
      } catch (error) {
        output.error('Failed to send AUTH1', error instanceof Error ? error.message : String(error));
        ws.close();
        reject(error);
      }
    });
    
    let authenticated = false;
    let passwordVerified = false;
    let requiresPassword = false;
    let nonceC: string | undefined;
    
    ws.on('message', async (data) => {
      if (!(data instanceof Buffer)) return;
      
      const frames = reader.push(data);
      for (const frame of frames) {
        try {
          if (frame.type === FrameType.AUTH2 && !authenticated) {
            // Handle AUTH2
            const encrypted = decode(frame.payload) as any;
            const decrypted = aeadDecrypt(keys.K_enc, FrameType.AUTH2, encrypted.nonce, encrypted.cipher);
            const auth2 = decrypted.msg;
            
            nonceC = auth2.nonceC;
            requiresPassword = auth2.requiresPassword || false;
            
            // Send AUTH3
            const auth3Data = new TextEncoder().encode('ready' + nonceC);
            const auth3Hmac = computeHmac(keys.K_auth, auth3Data);
            const auth3Frame = encodeFrame(FrameType.AUTH3, auth3Hmac);
            ws.send(auth3Frame);
            
            authenticated = true;
            output.info('Authenticated');
            
            // If password is required, send it
            if (requiresPassword) {
              if (!password) {
                // Interactive prompt for password
                const readline = await import('readline');
                const rl = readline.createInterface({
                  input: process.stdin,
                  output: process.stdout
                });
                
                const passwordPromise = new Promise<string>((resolve) => {
                  rl.question('Agent password: ', (answer) => {
                    rl.close();
                    resolve(answer);
                  });
                });
                
                password = await passwordPromise;
              }
              
              output.info('Sending password...');
              const pwMsg = {
                ctr: counters.outgoing.next(),
                msg: { password }
              };
              
              const pwEncrypted = aeadEncrypt(keys.K_enc, FrameType.AUTH_PW, pwMsg.ctr, pwMsg.msg);
              const pwFrame = encodeFrame(FrameType.AUTH_PW, encode(pwEncrypted));
              ws.send(pwFrame);
            } else {
              passwordVerified = true;
              
              // Send TTY_OPEN immediately if no password required
            const ttyOpen = {
              sessionId,
              cwd,
              cols,
              rows,
            };
            
            const ttyOpenEncrypted = aeadEncrypt(keys.K_enc, FrameType.TTY_OPEN, counters.outgoing.next(), ttyOpen);
            const ttyOpenFrame = encodeFrame(FrameType.TTY_OPEN, encode(ttyOpenEncrypted));
            ws.send(ttyOpenFrame);
            
            // Set up terminal input
            setupTerminalInput(ws, keys, counters, sessionId);
            
            // Handle terminal resize
            process.stdout.on('resize', () => {
              const newCols = process.stdout.columns || 80;
              const newRows = process.stdout.rows || 24;
              
              const resize = {
                sessionId,
                cols: newCols,
                rows: newRows,
              };
              
              const resizeEncrypted = aeadEncrypt(keys.K_enc, FrameType.TTY_RESIZE, counters.outgoing.next(), resize);
              const resizeFrame = encodeFrame(FrameType.TTY_RESIZE, encode(resizeEncrypted));
              ws.send(resizeFrame);
            });
            }
            
          } else if (frame.type === FrameType.AUTH_PW && authenticated && !passwordVerified) {
            // Handle password response
            const encrypted = decode(frame.payload) as any;
            const decrypted = aeadDecrypt(keys.K_enc, FrameType.AUTH_PW, encrypted.nonce, encrypted.cipher);
            counters.incoming.validate(decrypted.ctr);
            
            const pwResponse = decrypted.msg as { ok: boolean };
            if (pwResponse.ok) {
              output.info('Password verified');
              passwordVerified = true;
              
              // Now send TTY_OPEN
              const ttyOpen = {
                sessionId,
                cwd,
                cols,
                rows,
              };
              
              const ttyOpenEncrypted = aeadEncrypt(keys.K_enc, FrameType.TTY_OPEN, counters.outgoing.next(), ttyOpen);
              const ttyOpenFrame = encodeFrame(FrameType.TTY_OPEN, encode(ttyOpenEncrypted));
              ws.send(ttyOpenFrame);
              
              // Set up terminal input
              setupTerminalInput(ws, keys, counters, sessionId);
              
              // Handle terminal resize
              process.stdout.on('resize', () => {
                const newCols = process.stdout.columns || 80;
                const newRows = process.stdout.rows || 24;
                
                const resize = {
                  sessionId,
                  cols: newCols,
                  rows: newRows,
                };
                
                const resizeEncrypted = aeadEncrypt(keys.K_enc, FrameType.TTY_RESIZE, counters.outgoing.next(), resize);
                const resizeFrame = encodeFrame(FrameType.TTY_RESIZE, encode(resizeEncrypted));
                ws.send(resizeFrame);
              });
            } else {
              output.error('Password verification failed');
              ws.close();
              reject(new Error('Password verification failed'));
            }
            
          } else if (frame.type === FrameType.TTY_DATA && authenticated) {
            // Handle TTY data from server
            const encrypted = decode(frame.payload) as any;
            const decrypted = aeadDecrypt(keys.K_enc, FrameType.TTY_DATA, encrypted.nonce, encrypted.cipher);
            counters.incoming.validate(decrypted.ctr);
            
            const msg = decrypted.msg as TtyDataMessage['msg'];
            if (msg.sessionId === sessionId) {
              process.stdout.write(Buffer.from(msg.chunk));
            }
            
          } else if (frame.type === FrameType.TTY_EXIT && authenticated) {
            // Handle TTY exit
            const encrypted = decode(frame.payload) as any;
            const decrypted = aeadDecrypt(keys.K_enc, FrameType.TTY_EXIT, encrypted.nonce, encrypted.cipher);
            counters.incoming.validate(decrypted.ctr);
            
            const msg = decrypted.msg as TtyExitMessage['msg'];
            if (msg.sessionId === sessionId) {
              output.info(`Terminal exited: code=${msg.code}, signal=${msg.signal}`);
              ws.close();
              resolve();
            }
            
          } else if (frame.type === FrameType.ERROR) {
            // Handle error
            const encrypted = decode(frame.payload) as any;
            const decrypted = aeadDecrypt(keys.K_enc, FrameType.ERROR, encrypted.nonce, encrypted.cipher);
            const error = decrypted.msg;
            output.error('Server error', error instanceof Error ? error.message : String(error));
            ws.close();
            reject(new Error(`Server error: ${error.code} - ${error.detail}`));
          }
        } catch (error) {
          output.error(`Failed to handle frame type ${frame.type}`, error instanceof Error ? error.message : String(error));
        }
      }
    });
    
    ws.on('error', (error) => {
      output.error('WebSocket error', error instanceof Error ? error.message : String(error));
      reject(error);
    });
    
    ws.on('close', () => {
      output.info('Disconnected');
      resolve();
    });
  });
}

function setupTerminalInput(
  ws: WebSocket, 
  keys: any, 
  counters: BidirectionalCounters, 
  sessionId: string
): void {
  // Set terminal to raw mode
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  
  // Handle input
  process.stdin.on('data', (data) => {
    const ttyData = {
      sessionId,
      chunk: new Uint8Array(data),
    };
    
    const dataEncrypted = aeadEncrypt(keys.K_enc, FrameType.TTY_DATA, counters.outgoing.next(), ttyData);
    const dataFrame = encodeFrame(FrameType.TTY_DATA, encode(dataEncrypted));
    ws.send(dataFrame);
  });
  
  // Handle Ctrl+C
  process.on('SIGINT', () => {
    const signal = {
      sessionId,
      signal: 'SIGINT' as const,
    };
    
    const signalEncrypted = aeadEncrypt(keys.K_enc, FrameType.TTY_SIGNAL, counters.outgoing.next(), signal);
    const signalFrame = encodeFrame(FrameType.TTY_SIGNAL, encode(signalEncrypted));
    ws.send(signalFrame);
  });
  
  // Cleanup on exit
  const cleanup = () => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  };
  
  process.on('exit', cleanup);
  ws.on('close', cleanup);
}