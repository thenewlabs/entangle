import WebSocket from 'ws';
import { deriveKeys, extractSaltFromCapId, aeadEncrypt, aeadDecrypt, computeHmac } from '@sunpix/entangle-crypto';
import { FrameType, FrameReader, encodeFrame, StdoutMessage, StderrMessage, ExitMessage } from '@sunpix/entangle-protocol';
import { OutputHandler, parseOutputMode, BidirectionalCounters } from '@sunpix/entangle-utils';
import { encode, decode } from 'cborg';

const output = new OutputHandler({ mode: parseOutputMode(process.env.OUTPUT_MODE || 'text') });

export async function runSingle(
  wsUrl: string, 
  S: string, 
  options: { argv: string[]; cwd?: string | undefined; abortAfterMs?: number | undefined }
): Promise<void> {
  const { argv, cwd, abortAfterMs } = options;
  
  if (!argv || argv.length === 0) {
    throw new Error('No command provided');
  }
  
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
  
  // Command ID for this run
  const commandId = Math.random().toString(36).substr(2, 9);
  
  return new Promise((_, reject) => {
    let abortTimeout: NodeJS.Timeout | undefined;
    
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
    let nonceC: string | undefined;
    let exitCode = 0;
    
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
            output.info('Authenticated');
            
            // Send RUN command
            const runMsg = {
              commandId,
              argv,
              cwd,
              limits: abortAfterMs ? { wallMs: abortAfterMs } : undefined,
            };
            
            const runEncrypted = aeadEncrypt(keys.K_enc, FrameType.RUN, counters.outgoing.next(), runMsg);
            const runFrame = encodeFrame(FrameType.RUN, encode(runEncrypted));
            ws.send(runFrame);
            
            // Set abort timeout if specified
            if (abortAfterMs) {
              abortTimeout = setTimeout(() => {
                output.info('Aborting command due to timeout');
                const abortMsg = {
                  commandId,
                  reason: 'timeout',
                };
                
                const abortEncrypted = aeadEncrypt(keys.K_enc, FrameType.ABORT, counters.outgoing.next(), abortMsg);
                const abortFrame = encodeFrame(FrameType.ABORT, encode(abortEncrypted));
                ws.send(abortFrame);
              }, abortAfterMs);
            }
            
          } else if (frame.type === FrameType.STDOUT && authenticated) {
            // Handle stdout
            const encrypted = decode(frame.payload) as any;
            const decrypted = aeadDecrypt(keys.K_enc, FrameType.STDOUT, encrypted.nonce, encrypted.cipher);
            counters.incoming.validate(decrypted.ctr);
            
            const msg = decrypted.msg as StdoutMessage['msg'];
            if (msg.commandId === commandId) {
              process.stdout.write(Buffer.from(msg.chunk));
            }
            
          } else if (frame.type === FrameType.STDERR && authenticated) {
            // Handle stderr
            const encrypted = decode(frame.payload) as any;
            const decrypted = aeadDecrypt(keys.K_enc, FrameType.STDERR, encrypted.nonce, encrypted.cipher);
            counters.incoming.validate(decrypted.ctr);
            
            const msg = decrypted.msg as StderrMessage['msg'];
            if (msg.commandId === commandId) {
              process.stderr.write(Buffer.from(msg.chunk));
            }
            
          } else if (frame.type === FrameType.EXIT && authenticated) {
            // Handle exit
            const encrypted = decode(frame.payload) as any;
            const decrypted = aeadDecrypt(keys.K_enc, FrameType.EXIT, encrypted.nonce, encrypted.cipher);
            counters.incoming.validate(decrypted.ctr);
            
            const msg = decrypted.msg as ExitMessage['msg'];
            if (msg.commandId === commandId) {
              exitCode = msg.code ?? 1;
              output.info(`Command exited: code=${msg.code}, signal=${msg.signal}, bytesOut=${msg.bytesOut}`);
              
              if (abortTimeout) {
                clearTimeout(abortTimeout);
              }
              
              ws.close();
              process.exit(exitCode);
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
      if (abortTimeout) {
        clearTimeout(abortTimeout);
      }
      process.exit(exitCode);
    });
    
    // Handle SIGINT
    process.on('SIGINT', () => {
      if (authenticated && ws.readyState === WebSocket.OPEN) {
        const abortMsg = {
          commandId,
          reason: 'user interrupt',
        };
        
        const sigintEncrypted = aeadEncrypt(keys.K_enc, FrameType.ABORT, counters.outgoing.next(), abortMsg);
        const sigintFrame = encodeFrame(FrameType.ABORT, encode(sigintEncrypted));
        ws.send(sigintFrame);
      }
      ws.close();
      process.exit(130); // 128 + SIGINT(2)
    });
  });
}