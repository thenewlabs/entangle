import WebSocket from 'ws';
import { 
  FrameType, 
  encodeFrame,
  StreamOpenMessage,
  StreamDataMessage,
  StreamResizeMessage,
  StreamSignalMessage,
  StreamCloseMessage,
  StreamOpenedMessage,
  StreamExitMessage,
  StreamClosedMessage,
  StreamErrorMessage,
} from '@sunpix/entangle-protocol';
import {
  deriveKeys,
  streamAeadEncrypt,
  streamAeadDecrypt,
  aeadDecrypt,
} from '@sunpix/entangle-crypto';
import { 
  OutputHandler,
  parseOutputMode,
  BidirectionalCounters,
  StreamCounters,
} from '@sunpix/entangle-utils';
import { encode, decode } from 'cborg';
import { StreamManager } from './stream-manager.js';
import type { CapabilityInfo } from './capability.js';

const output = new OutputHandler({ mode: parseOutputMode(process.env.OUTPUT_MODE || 'text') });

export interface MultiSession {
  socketId: string;
  ws: WebSocket;
  cap: CapabilityInfo;
  keys?: Awaited<ReturnType<typeof deriveKeys>>;
  counters: BidirectionalCounters; // For auth and legacy mode
  streamCounters: StreamCounters; // Per-stream counters
  authenticated: boolean;
  nonceB?: string;
  nonceC?: string;
  streamManager?: StreamManager;
  // For backward compatibility
  legacyMode: boolean;
  hasRun: boolean; // Only used in legacy single-stream mode
}

// Helper to send encrypted messages with per-stream counters
async function sendEncrypted(
  session: MultiSession,
  frameType: FrameType,
  message: any,
  sid?: string
): Promise<void> {
  if (!session.keys) {
    throw new Error('Session not authenticated');
  }

  // If we have a stream ID, update the counter
  if (sid && 'ctr' in message) {
    message.ctr = session.streamCounters.increment(sid, 'outgoing');
  }

  const plaintext = encode(message);
  const aad = encode({ type: frameType });
  const ciphertext = await streamAeadEncrypt(session.keys.K_enc, plaintext, aad);
  const frame = encodeFrame(frameType, ciphertext);

  session.ws.send(frame);
}

// Handle stream open request
async function handleStreamOpen(
  session: MultiSession,
  message: StreamOpenMessage
): Promise<void> {
  if (!session.streamManager) {
    session.streamManager = new StreamManager({
      policy: session.cap.policy,
      output,
      onStreamData: async (sid, data) => {
        await sendStreamData(session, sid, data);
      },
      onStreamExit: async (sid, code, signal, usage) => {
        await sendStreamExit(session, sid, code, signal, usage);
      },
      onStreamError: async (sid, error) => {
        await sendStreamError(session, sid, error);
      },
    });
  }

  try {
    const { mode, pty, exec } = message.msg;
    let actualSid: string;

    if (mode === 'pty' && pty) {
      const ptyOptions: any = {
        cols: pty.cols,
        rows: pty.rows,
      };
      if (pty.env) {
        ptyOptions.env = pty.env;
      }
      if (exec?.cwd) {
        ptyOptions.cwd = exec.cwd;
      }
      actualSid = await session.streamManager.openPtyStream(ptyOptions);
    } else if (mode === 'cmd' && exec) {
      const cmdOptions: any = {
        argv: exec.argv,
      };
      if (exec.cwd) {
        cmdOptions.cwd = exec.cwd;
      }
      if (exec.env) {
        cmdOptions.env = exec.env;
      }
      if (exec.stdin !== undefined) {
        cmdOptions.stdin = exec.stdin;
      }
      actualSid = await session.streamManager.openCmdStream(cmdOptions);
    } else {
      throw new Error(`Invalid stream configuration for mode ${mode}`);
    }

    // Send opened confirmation
    const openedMsg: StreamOpenedMessage = {
      ctr: 0, // Will be set by sendEncrypted
      msg: {
        v: 1,
        kind: 'opened',
        sid: actualSid,
        startedAt: Date.now(),
        mode,
      },
    };

    await sendEncrypted(session, FrameType.STREAM_OPEN, openedMsg, actualSid);
  } catch (error: any) {
    await sendStreamError(session, message.msg.sid, error.message);
  }
}

// Handle stream data (stdin)
async function handleStreamData(
  session: MultiSession,
  message: StreamDataMessage
): Promise<void> {
  if (!session.streamManager) {
    await sendStreamError(session, message.msg.sid, 'No active streams');
    return;
  }

  try {
    session.streamManager.writeToStream(message.msg.sid, message.msg.chunk);
  } catch (error: any) {
    await sendStreamError(session, message.msg.sid, error.message);
  }
}

// Handle stream resize (PTY only)
async function handleStreamResize(
  session: MultiSession,
  message: StreamResizeMessage
): Promise<void> {
  if (!session.streamManager) {
    await sendStreamError(session, message.msg.sid, 'No active streams');
    return;
  }

  try {
    session.streamManager.resizePtyStream(
      message.msg.sid,
      message.msg.cols,
      message.msg.rows
    );
  } catch (error: any) {
    await sendStreamError(session, message.msg.sid, error.message);
  }
}

// Handle stream signal
async function handleStreamSignal(
  session: MultiSession,
  message: StreamSignalMessage
): Promise<void> {
  if (!session.streamManager) {
    await sendStreamError(session, message.msg.sid, 'No active streams');
    return;
  }

  try {
    session.streamManager.signalStream(message.msg.sid, message.msg.signal);
  } catch (error: any) {
    await sendStreamError(session, message.msg.sid, error.message);
  }
}

// Handle stream close
async function handleStreamClose(
  session: MultiSession,
  message: StreamCloseMessage
): Promise<void> {
  if (!session.streamManager) {
    return;
  }

  session.streamManager.closeStream(message.msg.sid, 'Client requested close');

  // Send closed confirmation
  const closedMsg: StreamClosedMessage = {
    ctr: 0, // Will be set by sendEncrypted
    msg: {
      v: 1,
      kind: 'closed',
      sid: message.msg.sid,
    },
  };

  await sendEncrypted(session, FrameType.STREAM_CLOSE, closedMsg, message.msg.sid);
  // Clean up stream counters
  session.streamCounters.removeStream(message.msg.sid);
}

// Send stream data to client
async function sendStreamData(
  session: MultiSession,
  sid: string,
  data: Uint8Array
): Promise<void> {
  const msg = {
    ctr: 0, // Will be set by sendEncrypted
    msg: {
      v: 1 as const,
      kind: 'data' as const,
      sid,
      chunk: data,
    },
  };

  await sendEncrypted(session, FrameType.STREAM_DATA, msg, sid);
}

// Send stream exit to client
async function sendStreamExit(
  session: MultiSession,
  sid: string,
  code: number | null,
  signal: string | null,
  usage?: any
): Promise<void> {
  const msg: StreamExitMessage = {
    ctr: 0, // Will be set by sendEncrypted
    msg: {
      v: 1,
      kind: 'exit',
      sid,
      code,
      signal,
      usage,
    },
  };

  await sendEncrypted(session, FrameType.STREAM_EXIT, msg, sid);
  // Clean up stream counters after exit
  session.streamCounters.removeStream(sid);
}

// Send stream error to client
async function sendStreamError(
  session: MultiSession,
  sid: string,
  error: string
): Promise<void> {
  const msg: StreamErrorMessage = {
    ctr: 0, // Will be set by sendEncrypted
    msg: {
      v: 1,
      kind: 'error',
      sid,
      message: error,
    },
  };

  await sendEncrypted(session, FrameType.STREAM_ERROR, msg, sid);
}

// Main frame handler for multi-stream protocol
export async function handleMultiStreamFrame(
  session: MultiSession,
  frame: { type: FrameType; payload: Uint8Array }
): Promise<void> {
  if (!session.authenticated) {
    output.warn(`Received frame before authentication: type=${frame.type}`);
    session.ws.close(1002, 'Not authenticated');
    return;
  }

  if (!session.keys) {
    throw new Error('Keys not derived');
  }

  try {
    // Log diagnostics for STREAM frames
    if (
      frame.type === FrameType.STREAM_OPEN ||
      frame.type === FrameType.STREAM_DATA ||
      frame.type === FrameType.STREAM_CLOSE ||
      frame.type === FrameType.STREAM_SIGNAL ||
      frame.type === FrameType.STREAM_RESIZE ||
      frame.type === FrameType.STREAM_ERROR ||
      frame.type === FrameType.STREAM_EXIT
    ) {
      output.info(`MultiStream frame received: type=${frame.type} payloadLen=${frame.payload.length}`);
      // Debug: log first few bytes of payload
      const preview = Array.from(frame.payload.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' ');
      output.debug(`Payload preview (first 32 bytes): ${preview}`);
    }
    // Decrypt the payload (prefer stream AEAD). If that fails, attempt
    // backward-compatible CBOR-wrapped AEAD decryption.
    const aad = encode({ type: frame.type });
    output.debug(`AAD for decryption: ${Array.from(aad).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    let message: any;
    try {
      const plaintext = await streamAeadDecrypt(session.keys.K_enc, frame.payload, aad);
      message = decode(plaintext) as any;
    } catch (primaryErr: any) {
      output.warn(`Stream decrypt failed for type=${frame.type}, payloadLen=${frame.payload.length}: ${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)}`);
      try {
        // Fallback: treat payload as CBOR { nonce, cipher }
        const enc = decode(frame.payload) as any;
        if (enc && enc.nonce && enc.cipher) {
          const decoded = aeadDecrypt(session.keys.K_enc, frame.type, enc.nonce, enc.cipher);
          message = decoded as any;
        } else {
          throw primaryErr;
        }
      } catch (_fallbackErr) {
        output.warn(`Fallback decrypt also failed for type=${frame.type}`);
        throw primaryErr;
      }
    }

    // For stream messages, verify per-stream counter
    if (message.msg && message.msg.sid) {
      const sid = message.msg.sid;
      const expectedCounter = session.streamCounters.getNext(sid, 'incoming');
      if (message.ctr !== expectedCounter) {
        output.error(`Stream counter mismatch for stream ${sid}: expected=${expectedCounter}, received=${message.ctr}`);
        session.ws.close(1002, 'Counter mismatch');
        return;
      }
      session.streamCounters.increment(sid, 'incoming');
    } else {
      // Non-stream messages use global counter
      try {
        session.counters.incoming.validate(message.ctr);
      } catch (err: any) {
        output.error('Counter mismatch', err.message);
        session.ws.close(1002, 'Counter mismatch');
        return;
      }
    }

    // Handle frame based on type
    switch (frame.type) {
      case FrameType.STREAM_OPEN:
        await handleStreamOpen(session, message as StreamOpenMessage);
        break;

      case FrameType.STREAM_DATA:
        await handleStreamData(session, message as StreamDataMessage);
        break;

      case FrameType.STREAM_RESIZE:
        await handleStreamResize(session, message as StreamResizeMessage);
        break;

      case FrameType.STREAM_SIGNAL:
        await handleStreamSignal(session, message as StreamSignalMessage);
        break;

      case FrameType.STREAM_CLOSE:
        await handleStreamClose(session, message as StreamCloseMessage);
        break;

      case FrameType.KEEPALIVE:
        // Echo keepalive back
        await sendEncrypted(session, FrameType.KEEPALIVE, message);
        break;

      default:
        output.warn(`Unknown frame type in multi-stream mode: ${frame.type}`);
    }
  } catch (error: any) {
    output.error(`Error handling multi-stream frame type ${frame.type}`, error.message);
    session.ws.close(1002, 'Protocol error');
  }
}

// Clean up session
export function cleanupMultiSession(session: MultiSession): void {
  if (session.streamManager) {
    session.streamManager.closeAllStreams('Session cleanup');
  }
}
