import WebSocket from 'ws';
import { deriveKeys, extractSaltFromCapId, aeadEncrypt, aeadDecrypt, computeHmac } from '@sunpix/entangle-crypto';
import { FrameType, FrameReader, encodeFrame, TtyDataMessage, TtyExitMessage } from '@sunpix/entangle-protocol';
import { createLogger, BidirectionalCounters } from '@sunpix/entangle-utils';
import { encode, decode } from 'cborg';
// import * as readline from 'readline';

const logger = createLogger('terminal');

export async function openTerminal(
  wsUrl: string, 
  S: string, 
  options: { cwd?: string | undefined; cols?: number | undefined; rows?: number | undefined }
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
      logger.info('Connected to relay');
      
      try {
        // Send AUTH1
        const auth1Data = new TextEncoder().encode('hello' + capId + Math.random().toString(36));
        const auth1Hmac = computeHmac(keys.K_auth, auth1Data);
        const auth1Frame = encodeFrame(FrameType.AUTH1, auth1Hmac);
        ws.send(auth1Frame);
      } catch (error) {
        logger.error({ error }, 'Failed to send AUTH1');
        ws.close();
        reject(error);
      }
    });
    
    let authenticated = false;
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
            
            // Send AUTH3
            const auth3Data = new TextEncoder().encode('ready' + nonceC);
            const auth3Hmac = computeHmac(keys.K_auth, auth3Data);
            const auth3Frame = encodeFrame(FrameType.AUTH3, auth3Hmac);
            ws.send(auth3Frame);
            
            authenticated = true;
            logger.info('Authenticated');
            
            // Send TTY_OPEN
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
              logger.info({ code: msg.code, signal: msg.signal }, 'Terminal exited');
              ws.close();
              resolve();
            }
            
          } else if (frame.type === FrameType.ERROR) {
            // Handle error
            const encrypted = decode(frame.payload) as any;
            const decrypted = aeadDecrypt(keys.K_enc, FrameType.ERROR, encrypted.nonce, encrypted.cipher);
            const error = decrypted.msg;
            logger.error({ error }, 'Server error');
            ws.close();
            reject(new Error(`Server error: ${error.code} - ${error.detail}`));
          }
        } catch (error) {
          logger.error({ error, frameType: frame.type }, 'Failed to handle frame');
        }
      }
    });
    
    ws.on('error', (error) => {
      logger.error({ error }, 'WebSocket error');
      reject(error);
    });
    
    ws.on('close', () => {
      logger.info('Disconnected');
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