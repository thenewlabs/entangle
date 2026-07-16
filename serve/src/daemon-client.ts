import * as net from 'net';
import * as fs from 'fs';
import { spawn } from 'child_process';
import type { OutputHandler } from '@thenewlabs/entangle-utils';
import { attachHostTerminal } from './host-terminal.js';
import { RemoteHostSession } from './remote-host-session.js';

/**
 * The CLIENT half of the tmux-style detach/reattach split: helpers for spawning
 * a detached session daemon and attaching the current terminal to its unix
 * socket. Extracted from the serve CLI wiring so embedders (Locus's CLI) can
 * compose the same spawn/poll/attach flow around their own daemon entry.
 */

/** How long to wait for a freshly spawned daemon's socket to become connectable. */
const SOCKET_POLL_INTERVAL_MS = 100;
const SOCKET_POLL_TIMEOUT_MS = 8000;

/** Resolve after `ms`. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Connect to a unix socket, rejecting on connection error. */
export function connectSocket(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    const onError = (err: Error): void => reject(err);
    socket.once('error', onError);
    socket.once('connect', () => { socket.removeListener('error', onError); resolve(socket); });
  });
}

/**
 * Poll a socket path until it accepts a connection, resolving the connected
 * socket. Rejects with a pointer to `logFile` if it never comes up in time. The
 * socket is left flowing-paused (no 'data' listener) so no daemon frames are
 * lost before the RemoteHostSession attaches its reader.
 */
export async function pollSocket(path: string, logFile: string): Promise<net.Socket> {
  const deadline = Date.now() + SOCKET_POLL_TIMEOUT_MS;
  for (;;) {
    try {
      return await connectSocket(path);
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(
          `Session daemon did not come up within ${SOCKET_POLL_TIMEOUT_MS / 1000}s (socket ${path}); see log: ${logFile}`,
        );
      }
      await delay(SOCKET_POLL_INTERVAL_MS);
    }
  }
}

/**
 * Spawn a detached daemon process whose stdout/stderr append to `logFile` and
 * whose config rides entirely in `env`. Returns immediately (the child is
 * unref'd); pair with {@link pollSocket} to wait for its socket.
 */
export function spawnDetached(opts: {
  entry: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  logFile: string;
}): void {
  const logFd = fs.openSync(opts.logFile, 'a');
  const child = spawn(process.execPath, [opts.entry, ...opts.args], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: opts.env,
  });
  child.unref();
  fs.closeSync(logFd); // the child holds its own fd
}

/**
 * Attach this terminal to a daemon over its (already connected) socket: wrap it
 * in a RemoteHostSession sized to the current terminal and hand it to the host
 * UI. host-terminal keeps the process alive and calls process.exit on the
 * session's exit/detach path.
 */
export function attachToSocket(socket: net.Socket, output: OutputHandler): void {
  const session = new RemoteHostSession(socket, {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  });
  attachHostTerminal(session, output);
}
