import { z } from 'zod';

export enum FrameType {
  AUTH1 = 0x01,
  AUTH2 = 0x02,
  AUTH3 = 0x03,
  AUTH_PW = 0x04, // Optional password authentication
  RUN = 0x10,
  STDIN = 0x11,
  STDOUT = 0x12,
  STDERR = 0x13,
  EXIT = 0x14,
  ERROR = 0x15,
  ABORT = 0x16,
  KEEPALIVE = 0x17,
  // Terminal mode (PTY)
  TTY_OPEN = 0x20,
  TTY_DATA = 0x21,
  TTY_RESIZE = 0x22,
  TTY_SIGNAL = 0x23,
  TTY_EXIT = 0x24,
  // Multi-stream control
  STREAM_OPEN = 0x30,
  STREAM_CLOSE = 0x31,
  STREAM_DATA = 0x32,
  STREAM_ERROR = 0x33,
  STREAM_EXIT = 0x34,
  STREAM_SIGNAL = 0x35,
  STREAM_RESIZE = 0x36,
  // Shared-workspace window control (tmux-style multi-window). Carries small
  // control messages (window ops client->server, window-state server->clients)
  // over the same AEAD/AAD path as the stream frames. See messages.ts.
  WINDOW_CTL = 0x40,
}

export const CapabilitySchema = z.object({
  capId: z.string(),
  S: z.string(),
});

export type Capability = z.infer<typeof CapabilitySchema>;

export const PolicySchema = z.object({
  maxCpuMs: z.number().optional(),
  maxMemMB: z.number().optional(),
  maxWallMs: z.number().optional(),
  maxOutBytes: z.number().optional(),
  singleRun: z.boolean().default(false), // Default to multi-run
  allowedCwdPrefixes: z.array(z.string()).optional(),
  // Multi-stream limits
  maxStreams: z.number().default(1), // Default to single stream for backward compatibility
  perStream: z.object({
    maxCpuMs: z.number().optional(),
    maxMemMB: z.number().optional(),
    maxWallMs: z.number().optional(),
    maxOutBytes: z.number().optional(),
  }).optional(),
  // Advertised pipe names (forwarded-channel allow-list). Hashed into the AUTH2
  // policyHash so the invoker can verify which named endpoints the capability
  // exposes. Endpoint targets stay agent-side; only the names are advertised.
  pipes: z.array(z.string()).optional(),
});

export type Policy = z.infer<typeof PolicySchema>;

export interface Frame {
  type: FrameType;
  payload: Uint8Array;
}

export type StreamMode = 'pty' | 'cmd' | 'pipe';

export interface StreamMetadata {
  sid: string; // Stream ID
  mode: StreamMode;
  startedAt: number;
  endedAt?: number;
}

export interface StreamPtyOptions {
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

export interface StreamExecOptions {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: boolean;
}

export interface StreamPipeOptions {
  // Name of a registered forwarded channel (allow-list key). The agent resolves
  // it to a local unix/tcp endpoint; the client never sees the target.
  name: string;
}

export interface StreamUsage {
  cpuMs: number;
  rssMaxBytes: number;
  wallMs: number;
  outBytes: number;
}