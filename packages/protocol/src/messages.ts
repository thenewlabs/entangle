import { z } from 'zod';

export const RunMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    commandId: z.string(),
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
  requiresPassword: z.boolean().optional(),
});

export type RunMessage = z.infer<typeof RunMessageSchema>;
export type StdoutMessage = z.infer<typeof StdoutMessageSchema>;
export type StderrMessage = z.infer<typeof StderrMessageSchema>;
export type ExitMessage = z.infer<typeof ExitMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type AbortMessage = z.infer<typeof AbortMessageSchema>;
export type KeepaliveMessage = z.infer<typeof KeepaliveMessageSchema>;
export type Auth2Message = z.infer<typeof Auth2MessageSchema>;

// Terminal (PTY) messages
export const TtyOpenMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    sessionId: z.string(),
    cwd: z.string().optional(),
    cols: z.number(),
    rows: z.number(),
  }),
});

export const TtyDataMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    sessionId: z.string(),
    chunk: z.instanceof(Uint8Array),
  }),
});

export const TtyResizeMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    sessionId: z.string(),
    cols: z.number(),
    rows: z.number(),
  }),
});

export const TtySignalMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    sessionId: z.string(),
    signal: z.enum(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']),
  }),
});

export const TtyExitMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    sessionId: z.string(),
    code: z.number().nullable(),
    signal: z.string().nullable(),
  }),
});

export type TtyOpenMessage = z.infer<typeof TtyOpenMessageSchema>;
export type TtyDataMessage = z.infer<typeof TtyDataMessageSchema>;
export type TtyResizeMessage = z.infer<typeof TtyResizeMessageSchema>;
export type TtySignalMessage = z.infer<typeof TtySignalMessageSchema>;
export type TtyExitMessage = z.infer<typeof TtyExitMessageSchema>;

export enum ErrorCode {
  AUTH_FAILED = 'auth_failed',
  TOOL_NOT_ALLOWED = 'tool_not_allowed',
  ARG_LIMIT_EXCEEDED = 'arg_limit_exceeded',
  CWD_NOT_ALLOWED = 'cwd_not_allowed',
  RESOURCE_EXCEEDED = 'resource_exceeded',
  MULTI_RUN_NOT_ALLOWED = 'multi_run_not_allowed',
  UNKNOWN_COMMAND_ID = 'unknown_command_id',
  INTERNAL_ERROR = 'internal_error',
  STREAM_LIMIT_EXCEEDED = 'stream_limit_exceeded',
  UNKNOWN_STREAM_ID = 'unknown_stream_id',
  INVALID_STREAM_MODE = 'invalid_stream_mode',
}

// Multi-stream messages
export const StreamOpenMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    v: z.literal(1),
    kind: z.literal('open'),
    sid: z.string(),
    mode: z.enum(['pty', 'cmd', 'pipe']),
    pty: z.object({
      cols: z.number(),
      rows: z.number(),
      env: z.record(z.string()).optional(),
    }).optional(),
    exec: z.object({
      argv: z.array(z.string()),
      cwd: z.string().optional(),
      env: z.record(z.string()).optional(),
      stdin: z.boolean().optional(),
    }).optional(),
    // Forwarded-channel target: the registered pipe name to bridge this stream
    // to. Data flows as STREAM_DATA on channel 'stdout' in both directions.
    pipe: z.object({
      name: z.string(),
    }).optional(),
  }),
});

export const StreamDataMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    v: z.literal(1),
    kind: z.literal('data'),
    sid: z.string(),
    chunk: z.instanceof(Uint8Array),
    // Which output channel this data belongs to. Absent/`stdout` for stdin and
    // for merged output; `stderr` lets the invoker keep the streams separate.
    channel: z.enum(['stdout', 'stderr']).optional(),
  }),
});

export const StreamResizeMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    v: z.literal(1),
    kind: z.literal('pty-resize'),
    sid: z.string(),
    cols: z.number(),
    rows: z.number(),
  }),
});

export const StreamSignalMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    v: z.literal(1),
    kind: z.literal('signal'),
    sid: z.string(),
    signal: z.enum(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGKILL']),
  }),
});

export const StreamCloseMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    v: z.literal(1),
    kind: z.literal('close'),
    sid: z.string(),
  }),
});

export const StreamOpenedMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    v: z.literal(1),
    kind: z.literal('opened'),
    sid: z.string(),
    startedAt: z.number(),
    mode: z.enum(['pty', 'cmd', 'pipe']),
  }),
});

export const StreamExitMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    v: z.literal(1),
    kind: z.literal('exit'),
    sid: z.string(),
    code: z.number().nullable(),
    signal: z.string().nullable(),
    usage: z.object({
      cpu_ms: z.number(),
      rss_max: z.number(),
    }).optional(),
  }),
});

export const StreamClosedMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    v: z.literal(1),
    kind: z.literal('closed'),
    sid: z.string(),
  }),
});

export const StreamErrorMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    v: z.literal(1),
    kind: z.literal('error'),
    sid: z.string(),
    message: z.string(),
  }),
});

export type StreamOpenMessage = z.infer<typeof StreamOpenMessageSchema>;
export type StreamDataMessage = z.infer<typeof StreamDataMessageSchema>;
export type StreamResizeMessage = z.infer<typeof StreamResizeMessageSchema>;
export type StreamSignalMessage = z.infer<typeof StreamSignalMessageSchema>;
export type StreamCloseMessage = z.infer<typeof StreamCloseMessageSchema>;
export type StreamOpenedMessage = z.infer<typeof StreamOpenedMessageSchema>;
export type StreamExitMessage = z.infer<typeof StreamExitMessageSchema>;
export type StreamClosedMessage = z.infer<typeof StreamClosedMessageSchema>;
export type StreamErrorMessage = z.infer<typeof StreamErrorMessageSchema>;

// ---------------------------------------------------------------------------
// Shared-workspace window control (FrameType.WINDOW_CTL = 0x40)
// ---------------------------------------------------------------------------
//
// The shared workspace holds N windows (each its own PTY); exactly ONE is the
// GLOBAL active window whose output is streamed to every client's viewport. The
// WINDOW_CTL frame is the bidirectional control channel that carries window
// operations and window state. It is encrypted/authenticated exactly like the
// STREAM_* frames: CBOR-encoded envelope, AEAD with `frameAad(WINDOW_CTL, dir)`.
//
// Like the stream envelopes, every WINDOW_CTL message is `{ ctr, msg }`. These
// messages are NOT stream-scoped (no `sid`), so the counter is the SESSION
// GLOBAL counter (the same sequence used by AUTH_PW / ERROR), not a per-stream
// counter.
//
//   Client -> server (window ops), `msg.kind === 'op'`:
//     { v: 1, kind: 'op', op: 'new-window' }
//     { v: 1, kind: 'op', op: 'next-window' }
//     { v: 1, kind: 'op', op: 'prev-window' }
//     { v: 1, kind: 'op', op: 'select-window', index: number }   // 0-based index
//     { v: 1, kind: 'op', op: 'close-window',  index: number }   // 0-based index
//     { v: 1, kind: 'op', op: 'rename-window', index: number, title: string }
//
//   Server -> all clients (broadcast), `msg.kind === 'window-state'`:
//     { v: 1, kind: 'window-state',
//       windows: [{ id: string, title: string }, ...],  // order == tab order
//       activeIndex: number }                            // 0-based, index into `windows`
//
// The server broadcasts `window-state` to every attached client on ANY change
// (window created / closed / switched / renamed), and sends it once to a client
// immediately after it attaches so its tab bar can populate. On an active-window
// switch the server ALSO repaints each client's viewport: it writes a screen
// clear + the newly-active window's replay onto that client's existing pty
// stream (the sid from STREAM_OPEN) — no new stream is opened per window.

export const WindowInfoSchema = z.object({
  id: z.string(),
  title: z.string(),
});

/** A client->server window operation (the `msg` body of a WINDOW_CTL frame). */
export const WindowOpSchema = z.discriminatedUnion('op', [
  z.object({ v: z.literal(1), kind: z.literal('op'), op: z.literal('new-window') }),
  z.object({ v: z.literal(1), kind: z.literal('op'), op: z.literal('next-window') }),
  z.object({ v: z.literal(1), kind: z.literal('op'), op: z.literal('prev-window') }),
  z.object({ v: z.literal(1), kind: z.literal('op'), op: z.literal('select-window'), index: z.number().int().nonnegative() }),
  z.object({ v: z.literal(1), kind: z.literal('op'), op: z.literal('close-window'), index: z.number().int().nonnegative() }),
  z.object({ v: z.literal(1), kind: z.literal('op'), op: z.literal('rename-window'), index: z.number().int().nonnegative(), title: z.string().max(128) }),
]);

/** Client->server WINDOW_CTL envelope: a window operation. */
export const WindowCtlOpMessageSchema = z.object({
  ctr: z.number(),
  msg: WindowOpSchema,
});

/** Server->client WINDOW_CTL envelope: the full window state (for tab bars). */
export const WindowStateMessageSchema = z.object({
  ctr: z.number(),
  msg: z.object({
    v: z.literal(1),
    kind: z.literal('window-state'),
    windows: z.array(WindowInfoSchema),
    activeIndex: z.number().int(),
  }),
});

export type WindowInfo = z.infer<typeof WindowInfoSchema>;
export type WindowOp = z.infer<typeof WindowOpSchema>;
export type WindowCtlOpMessage = z.infer<typeof WindowCtlOpMessageSchema>;
export type WindowStateMessage = z.infer<typeof WindowStateMessageSchema>;
/** The `msg` body of a server->client window-state frame (sans envelope). */
export type WindowStateBody = WindowStateMessage['msg'];