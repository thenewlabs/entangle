import { Terminal } from 'xterm';
import { 
  FrameType, 
  FrameReader, 
  encodeFrame,
} from '@sunpix/entangle-protocol';
import {
  deriveKeys,
  extractSaltFromCapId,
  aeadEncrypt,
  aeadDecrypt,
  computeHmac,
  initCrypto,
} from '@sunpix/entangle-crypto';
import { encode, decode } from 'cborg';

export class RelayClient {
  private ws?: WebSocket;
  private keys?: Awaited<ReturnType<typeof deriveKeys>>;
  private reader = new FrameReader();
  private authenticated = false;
  private commandId?: string;
  private outgoingCtr = 0;
  private incomingCtr = -1;
  
  onConnect?: () => void;
  onDisconnect?: () => void;
  onExit?: (code: number) => void;
  
  constructor(
    private namespace: string,
    private capId: string,
    private S: string,
    private terminal: Terminal
  ) {}
  
  async connect(): Promise<void> {
    await initCrypto();
    
    const saltCap = extractSaltFromCapId(this.capId);
    this.keys = await deriveKeys(this.S, saltCap);
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const url = `${protocol}//${host}/relay/${this.namespace}/${this.capId}`;
    
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    
    this.ws.onopen = () => this.handleOpen();
    this.ws.onmessage = (e) => this.handleMessage(e);
    this.ws.onclose = () => this.handleClose();
    this.ws.onerror = (e) => console.error('WebSocket error:', e);
  }
  
  disconnect(): void {
    this.ws?.close();
  }
  
  async run(tool: string, argv: string[], cwd?: string): Promise<void> {
    if (!this.authenticated || !this.keys || !this.ws) {
      throw new Error('Not connected');
    }
    
    this.commandId = Math.random().toString(36).substr(2, 9);
    
    const runMsg = {
      ctr: this.nextOutgoingCtr(),
      msg: {
        commandId: this.commandId,
        tool,
        argv,
        cwd,
      },
    };
    
    const encrypted = aeadEncrypt(this.keys.K_enc, FrameType.RUN, runMsg.ctr, runMsg.msg);
    this.ws.send(encodeFrame(FrameType.RUN, encode(encrypted)));
  }
  
  abort(): void {
    if (!this.authenticated || !this.keys || !this.ws || !this.commandId) return;
    
    const abortMsg = {
      ctr: this.nextOutgoingCtr(),
      msg: {
        commandId: this.commandId,
        reason: 'User abort',
      },
    };
    
    const encrypted = aeadEncrypt(this.keys.K_enc, FrameType.ABORT, abortMsg.ctr, abortMsg.msg);
    this.ws.send(encodeFrame(FrameType.ABORT, encode(encrypted)));
  }
  
  private handleOpen(): void {
    if (!this.keys) return;
    
    const nonceB = crypto.getRandomValues(new Uint8Array(16));
    const nonceBHex = Array.from(nonceB).map(b => b.toString(16).padStart(2, '0')).join('');
    
    const auth1Data = new TextEncoder().encode('hello' + this.capId + nonceBHex);
    const auth1Hmac = computeHmac(this.keys.K_auth, auth1Data);
    
    this.ws!.send(encodeFrame(FrameType.AUTH1, auth1Hmac));
  }
  
  private handleMessage(event: MessageEvent): void {
    const data = new Uint8Array(event.data);
    const frames = this.reader.push(data);
    
    for (const frame of frames) {
      this.handleFrame(frame);
    }
  }
  
  private handleFrame(frame: { type: FrameType; payload: Uint8Array }): void {
    if (!this.keys) return;
    
    try {
      if (frame.type === FrameType.AUTH2 && !this.authenticated) {
        const encrypted = decode(frame.payload) as any;
        const decrypted = aeadDecrypt(this.keys.K_enc, FrameType.AUTH2, encrypted.nonce, encrypted.cipher);
        
        const auth2 = decrypted.msg as any;
        if (!auth2.ok) {
          throw new Error('Authentication failed');
        }
        
        const auth3Data = new TextEncoder().encode('ready' + auth2.nonceC);
        const auth3Hmac = computeHmac(this.keys.K_auth, auth3Data);
        
        this.ws!.send(encodeFrame(FrameType.AUTH3, auth3Hmac));
        
        this.authenticated = true;
        this.onConnect?.();
        
        this.terminal.writeln('Connected to Entangle');
      } else if (this.authenticated) {
        const encrypted = decode(frame.payload) as any;
        const decrypted = aeadDecrypt(this.keys.K_enc, frame.type, encrypted.nonce, encrypted.cipher);
        
        if (decrypted.ctr <= this.incomingCtr) {
          throw new Error('Counter not increasing');
        }
        this.incomingCtr = decrypted.ctr;
        
        switch (frame.type) {
          case FrameType.STDOUT:
            // chunk is already a Uint8Array after decryption
            this.terminal.write(decrypted.msg.chunk);
            break;
            
          case FrameType.STDERR:
            // chunk is already a Uint8Array after decryption
            this.terminal.write(decrypted.msg.chunk);
            break;
            
          case FrameType.EXIT:
            this.terminal.writeln(`\nProcess exited with code ${decrypted.msg.code}`);
            this.onExit?.(decrypted.msg.code || 0);
            break;
            
          case FrameType.ERROR:
            this.terminal.writeln(`\nError: ${decrypted.msg.detail || decrypted.msg.code}`);
            break;
        }
      }
    } catch (error) {
      console.error('Failed to handle frame:', error);
      this.terminal.writeln(`\nError: ${error}`);
    }
  }
  
  private handleClose(): void {
    this.authenticated = false;
    this.terminal.writeln('\nDisconnected');
    this.onDisconnect?.();
  }
  
  private nextOutgoingCtr(): number {
    return ++this.outgoingCtr;
  }
}