import { z } from 'zod';

export enum FrameType {
  AUTH1 = 0x01,
  AUTH2 = 0x02,
  AUTH3 = 0x03,
  RUN = 0x10,
  STDIN = 0x11,
  STDOUT = 0x12,
  STDERR = 0x13,
  EXIT = 0x14,
  ERROR = 0x15,
  ABORT = 0x16,
  KEEPALIVE = 0x17,
}

export const CapabilitySchema = z.object({
  namespace: z.string(),
  capId: z.string(),
  S: z.string(),
});

export type Capability = z.infer<typeof CapabilitySchema>;

export const PolicySchema = z.object({
  tool: z.string(),
  maxCpuMs: z.number().optional(),
  maxMemMB: z.number().optional(),
  maxWallMs: z.number().optional(),
  maxOutBytes: z.number().optional(),
  singleRun: z.boolean().default(true),
  allowedCwdPrefixes: z.array(z.string()).optional(),
});

export type Policy = z.infer<typeof PolicySchema>;

export interface Frame {
  type: FrameType;
  payload: Uint8Array;
}