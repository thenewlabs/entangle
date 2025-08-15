import WebSocket from 'ws';
import { 
  FrameType, 
  FrameReader, 
  encodeFrame,
  type RunMessage,
} from '@sunpix/entangle-protocol';
import {
  deriveKeys,
  extractSaltFromCapId,
  aeadEncrypt,
  aeadDecrypt,
  computeHmac,
  initCrypto,
} from '@sunpix/entangle-crypto';
import { 
  createLogger, 
  BidirectionalCounters,
} from '@sunpix/entangle-utils';
import { encode, decode } from 'cborg';

const logger = createLogger('invoke-run');

interface RunOptions {
  namespace: string;
  capId: string;
  S: string;
  tool: string;
  argv: string[];
  cwd: string | undefined;
  serverUrl: string;
  abortAfterMs: number | undefined;
  maxOutBytes: number | undefined;
}

export async function runCommand(options: RunOptions): Promise<number> {
  await initCrypto();
  
  const saltCap = extractSaltFromCapId(options.capId);
  const keys = await deriveKeys(options.S, saltCap);
  const counters = new BidirectionalCounters();
  
  const wsUrl = options.serverUrl.replace(/^http/, 'ws') + 
    `/relay/${options.namespace}/${options.capId}`;
  
  logger.info({ url: wsUrl }, 'Connecting to relay');
  
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const reader = new FrameReader();
    let authenticated = false;
    let nonceB: string;
    let commandId = Math.random().toString(36).substr(2, 9);
    let exitCode = 0;
    let abortTimer: NodeJS.Timeout | undefined;
    
    ws.on('open', async () => {
      logger.info('Connected, starting auth');
      
      nonceB = require('crypto').randomBytes(16).toString('hex');
      const auth1Data = new TextEncoder().encode('hello' + options.capId + nonceB);
      const auth1Hmac = computeHmac(keys.K_auth, auth1Data);
      
      ws.send(encodeFrame(FrameType.AUTH1, auth1Hmac));
    });
    
    ws.on('message', async (data) => {
      if (!(data instanceof Buffer)) return;
      
      const frames = reader.push(data);
      for (const frame of frames) {
        try {
          if (frame.type === FrameType.AUTH2 && !authenticated) {
            const auth2Encrypted = decode(frame.payload) as any;
            const decrypted = aeadDecrypt(keys.K_enc, FrameType.AUTH2, auth2Encrypted.nonce, auth2Encrypted.cipher);
            
            const auth2 = decrypted.msg as any;
            if (!auth2.ok || auth2.nonceB !== nonceB) {
              throw new Error('Invalid AUTH2 response');
            }
            
            const auth3Data = new TextEncoder().encode('ready' + auth2.nonceC);
            const auth3Hmac = computeHmac(keys.K_auth, auth3Data);
            
            ws.send(encodeFrame(FrameType.AUTH3, auth3Hmac));
            
            authenticated = true;
            logger.info('Authenticated, sending RUN');
            
            const runMsg: RunMessage = {
              ctr: counters.outgoing.next(),
              msg: {
                commandId,
                tool: options.tool,
                argv: options.argv,
                cwd: options.cwd,
                limits: {
                  maxOutBytes: options.maxOutBytes,
                },
              },
            };
            
            const runEncrypted = aeadEncrypt(keys.K_enc, FrameType.RUN, runMsg.ctr, runMsg.msg);
            ws.send(encodeFrame(FrameType.RUN, encode(runEncrypted)));
            
            if (options.abortAfterMs) {
              abortTimer = setTimeout(() => {
                logger.info('Sending abort');
                const abortMsg = {
                  ctr: counters.outgoing.next(),
                  msg: {
                    commandId,
                    reason: 'Timeout',
                  },
                };
                const abortEncrypted = aeadEncrypt(keys.K_enc, FrameType.ABORT, abortMsg.ctr, abortMsg.msg);
                ws.send(encodeFrame(FrameType.ABORT, encode(abortEncrypted)));
              }, options.abortAfterMs);
            }
          } else if (authenticated) {
            const msgEncrypted = decode(frame.payload) as any;
            const decrypted = aeadDecrypt(keys.K_enc, frame.type, msgEncrypted.nonce, msgEncrypted.cipher);
            counters.incoming.validate(decrypted.ctr);
            
            switch (frame.type) {
              case FrameType.STDOUT:
                process.stdout.write(Buffer.from(decrypted.msg.chunk));
                break;
                
              case FrameType.STDERR:
                process.stderr.write(Buffer.from(decrypted.msg.chunk));
                break;
                
              case FrameType.EXIT:
                if (abortTimer) clearTimeout(abortTimer);
                exitCode = decrypted.msg.code ?? 1;
                logger.info({ code: exitCode, signal: decrypted.msg.signal }, 'Command exited');
                ws.close();
                resolve(exitCode);
                break;
                
              case FrameType.ERROR:
                logger.error({ error: decrypted.msg }, 'Remote error');
                ws.close();
                reject(new Error(decrypted.msg.detail || decrypted.msg.code));
                break;
            }
          }
        } catch (error) {
          logger.error({ error }, 'Failed to handle frame');
          ws.close();
          reject(error);
        }
      }
    });
    
    ws.on('error', (error) => {
      logger.error({ error }, 'WebSocket error');
      reject(error);
    });
    
    ws.on('close', () => {
      if (abortTimer) clearTimeout(abortTimer);
      resolve(exitCode);
    });
  });
}