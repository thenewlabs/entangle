import { z } from 'zod';

export const RunMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    commandId: z.string(),
    tool: z.string(),
    argv: z.array(z.string()),
    cwd: z.string().optional(),
    limits: z.object({
      cpuMs: z.number().optional(),
      memMB: z.number().optional(),
      wallMs: z.number().optional(),
      maxOutBytes: z.number().optional(),
    }).optional(),
  }),
});

export const StdoutMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    commandId: z.string(),
    chunk: z.instanceof(Uint8Array),
  }),
});

export const StderrMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    commandId: z.string(),
    chunk: z.instanceof(Uint8Array),
  }),
});

export const ExitMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    commandId: z.string(),
    code: z.number().nullable(),
    signal: z.string().nullable(),
    bytesOut: z.number(),
  }),
});

export const ErrorMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    commandId: z.string().nullable(),
    code: z.string(),
    detail: z.string().optional(),
  }),
});

export const AbortMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    commandId: z.string(),
    reason: z.string().optional(),
  }),
});

export const KeepaliveMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    t: z.number(),
  }),
});

export const Auth2MessageSchema = z.object({
  ok: z.boolean(),
  nonceB: z.string(),
  nonceC: z.string(),
  expiryTs: z.number(),
  policyHash: z.string(),
});

export type RunMessage = z.infer<typeof RunMessageSchema>;
export type StdoutMessage = z.infer<typeof StdoutMessageSchema>;
export type StderrMessage = z.infer<typeof StderrMessageSchema>;
export type ExitMessage = z.infer<typeof ExitMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type AbortMessage = z.infer<typeof AbortMessageSchema>;
export type KeepaliveMessage = z.infer<typeof KeepaliveMessageSchema>;
export type Auth2Message = z.infer<typeof Auth2MessageSchema>;

export enum ErrorCode {
  AUTH_FAILED = 'auth_failed',
  TOOL_NOT_ALLOWED = 'tool_not_allowed',
  ARG_LIMIT_EXCEEDED = 'arg_limit_exceeded',
  CWD_NOT_ALLOWED = 'cwd_not_allowed',
  RESOURCE_EXCEEDED = 'resource_exceeded',
  MULTI_RUN_NOT_ALLOWED = 'multi_run_not_allowed',
  UNKNOWN_COMMAND_ID = 'unknown_command_id',
  INTERNAL_ERROR = 'internal_error',
}