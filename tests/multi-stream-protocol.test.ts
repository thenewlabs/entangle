import { describe, it, expect } from 'vitest';
import { 
  FrameType,
  StreamOpenMessage,
  StreamDataMessage,
  StreamResizeMessage,
  StreamSignalMessage,
  StreamCloseMessage,
} from '../packages/protocol/src/index.js';

describe('Multi-stream protocol types', () => {
  it('should have correct frame types', () => {
    expect(FrameType.STREAM_OPEN).toBe(0x30);
    expect(FrameType.STREAM_CLOSE).toBe(0x31);
    expect(FrameType.STREAM_DATA).toBe(0x32);
    expect(FrameType.STREAM_ERROR).toBe(0x33);
    expect(FrameType.STREAM_EXIT).toBe(0x34);
    expect(FrameType.STREAM_SIGNAL).toBe(0x35);
    expect(FrameType.STREAM_RESIZE).toBe(0x36);
  });

  it('should create valid stream open message for PTY', () => {
    const msg: StreamOpenMessage = {
      ctr: 0,
      msg: {
        v: 1,
        kind: 'open',
        sid: 'test-stream-123',
        mode: 'pty',
        pty: {
          cols: 120,
          rows: 40,
          env: { TERM: 'xterm-256color' },
        },
      },
    };

    expect(msg.msg.mode).toBe('pty');
    expect(msg.msg.pty?.cols).toBe(120);
    expect(msg.msg.pty?.rows).toBe(40);
  });

  it('should create valid stream open message for CMD', () => {
    const msg: StreamOpenMessage = {
      ctr: 0,
      msg: {
        v: 1,
        kind: 'open',
        sid: 'test-stream-456',
        mode: 'cmd',
        exec: {
          argv: ['ls', '-la'],
          cwd: '/home/user',
          env: { PATH: '/usr/bin:/bin' },
          stdin: true,
        },
      },
    };

    expect(msg.msg.mode).toBe('cmd');
    expect(msg.msg.exec?.argv).toEqual(['ls', '-la']);
    expect(msg.msg.exec?.stdin).toBe(true);
  });

  it('should create valid stream data message', () => {
    const data = new TextEncoder().encode('Hello, stream!');
    const msg: StreamDataMessage = {
      ctr: 5,
      msg: {
        v: 1,
        kind: 'data',
        sid: 'test-stream-789',
        chunk: data,
      },
    };

    expect(msg.msg.chunk).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(msg.msg.chunk)).toBe('Hello, stream!');
  });

  it('should create valid stream resize message', () => {
    const msg: StreamResizeMessage = {
      ctr: 10,
      msg: {
        v: 1,
        kind: 'pty-resize',
        sid: 'test-stream-pty',
        cols: 150,
        rows: 50,
      },
    };

    expect(msg.msg.cols).toBe(150);
    expect(msg.msg.rows).toBe(50);
  });

  it('should create valid stream signal message', () => {
    const msg: StreamSignalMessage = {
      ctr: 15,
      msg: {
        v: 1,
        kind: 'signal',
        sid: 'test-stream-sig',
        signal: 'SIGTERM',
      },
    };

    expect(msg.msg.signal).toBe('SIGTERM');
  });

  it('should create valid stream close message', () => {
    const msg: StreamCloseMessage = {
      ctr: 20,
      msg: {
        v: 1,
        kind: 'close',
        sid: 'test-stream-close',
      },
    };

    expect(msg.msg.sid).toBe('test-stream-close');
  });
});

describe('Multi-stream policy', () => {
  it('should support multi-stream configuration', () => {
    const policy = {
      singleRun: false,
      maxStreams: 10,
      perStream: {
        maxCpuMs: 60000,
        maxMemMB: 256,
        maxWallMs: 300000,
        maxOutBytes: 10 * 1024 * 1024, // 10MB
      },
    };

    expect(policy.maxStreams).toBe(10);
    expect(policy.perStream?.maxMemMB).toBe(256);
  });

  it('should default to single stream for backward compatibility', () => {
    const policy = {
      singleRun: false,
      maxStreams: 1, // Default
    };

    expect(policy.maxStreams).toBe(1);
  });
});