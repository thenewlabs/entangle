#!/usr/bin/env node

import * as net from 'net';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import { getConfig, getVersionInfo, OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';
import { startAgent } from './agent.js';
import { createCapability, resolveServeTarget, type CapabilityInfo } from './capability.js';
import { promptHidden } from './prompt.js';
import { SharedWorkspace } from './shared-workspace.js';
import { LocalHostSession } from './host-session.js';
import { attachHostTerminal } from './host-terminal.js';
import { RemoteHostSession } from './remote-host-session.js';
import {
  cleanupStale,
  defaultSessionName,
  ensureRunDir,
  findSession,
  isAlive,
  listSessions,
  logPath,
  removeSession,
  socketPath,
  type SessionInfo,
} from './session-registry.js';

// Hidden daemon entry: the interactive shared path spawns this same binary as
// `node <index.js> __daemon` (detached), which must run the headless daemon
// (see daemon.ts) rather than the CLI. Detected before the commander program is
// built/parsed so the daemon never touches argv parsing. Uses .then() rather
// than top-level await so the esbuild (cjs) standalone bundle still builds.
if (process.argv[2] === '__daemon') {
  import('./daemon.js')
    .then(({ runDaemon }) => runDaemon())
    .catch((err) => {
      console.error('Daemon failed to start:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
} else {
  runCli();
}

/** How long to wait for a freshly spawned daemon's socket to become connectable. */
const SOCKET_POLL_INTERVAL_MS = 100;
const SOCKET_POLL_TIMEOUT_MS = 8000;

/** Resolve after `ms`. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Connect to a unix socket, rejecting on connection error. */
function connectSocket(path: string): Promise<net.Socket> {
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
async function pollSocket(path: string, logFile: string): Promise<net.Socket> {
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
 * Spawn the detached daemon for `sessionName` (this same binary re-invoked with
 * the hidden `__daemon` arg) and poll its socket, resolving the connected socket
 * the host UI attaches to. The daemon inherits its config via env vars.
 */
async function spawnDaemon(opts: {
  sessionName: string;
  serverUrl: string;
  cap: CapabilityInfo;
  password?: string;
}): Promise<net.Socket> {
  const { sessionName, serverUrl, cap, password } = opts;
  ensureRunDir();
  const sock = socketPath(sessionName);
  const logFile = logPath(sessionName);
  const logFd = fs.openSync(logFile, 'a');
  const entry = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [entry, '__daemon'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      ENTANGLE_DAEMON_SESSION: sessionName,
      ENTANGLE_DAEMON_SOCKET: sock,
      ENTANGLE_DAEMON_SERVER: serverUrl,
      ENTANGLE_DAEMON_CAP: JSON.stringify(cap),
      ...(password ? { ENTANGLE_DAEMON_PASSWORD: password } : {}),
    },
  });
  child.unref();
  fs.closeSync(logFd); // the child holds its own fd
  return pollSocket(sock, logFile);
}

/**
 * Attach this terminal to a daemon over its (already connected) socket: wrap it
 * in a RemoteHostSession sized to the current terminal and hand it to the host
 * UI. host-terminal keeps the process alive and calls process.exit on the
 * session's exit/detach path.
 */
function attachToSocket(socket: net.Socket, output: OutputHandler): void {
  const session = new RemoteHostSession(socket, {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  });
  attachHostTerminal(session, output);
}

/** Reduce a session URL to a short, secret-free form (drops the `#S=` fragment). */
function shortUrl(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/** SIGTERM a session, drop it from the registry, and unlink its socket. */
function killSession(info: SessionInfo, output: OutputHandler): void {
  try { process.kill(info.pid, 'SIGTERM'); } catch { /* already gone */ }
  removeSession(info.name);
  try { fs.unlinkSync(info.socket); } catch { /* already gone */ }
  output.info(`Killed session "${info.name}" (pid ${info.pid}).`);
}

function runCli(): void {
const program = new Command();

program
  .name('entangle-serve')
  .description('Entangle secure agent for exposing CLI tools')
  .version(getVersionInfo())
  .option('--output-mode <mode>', 'Output mode: text or stream-json', 'text');

program
  // Default command: `entangle serve [url]` runs the agent without needing an
  // explicit `start`. The positional URL is either a bare relay origin
  // (mint a fresh capability there) or a full capability URL (serve that exact
  // capability); flags still work and take precedence over the positional.
  .command('start', { isDefault: true })
  .description('Start the agent (mint a fresh capability or serve a pinned one) and register with the relay')
  .argument('[url]', 'Relay origin (https://relay) to mint a fresh capability on, or a full capability URL (https://relay/cap/<capId>#S=<secret>) to serve that exact capability')
  .option('--server <url>', 'Relay server URL (overrides the origin of the positional URL)')
  .option('--password [password]', 'Require a password to connect; pass the flag alone to be prompted, or set AGENT_PASSWORD')
  .option('--capability <url>', 'Serve a specific capability URL (https://relay/cap/<capId>#S=<secret>) instead of minting a fresh ephemeral one; its host is also used as the relay server')
  .option('--shared', 'Serve one shared terminal that everyone with the URL attaches to (default when run in a terminal)')
  .option('--headless', 'Run headless: each connection gets its own shell instead of a shared terminal')
  .option('--session <name>', 'Name of the detachable session to start or reattach to (defaults to one derived from the capability)')
  .action(async (url: string | undefined, options) => {
    try {
      // Propagate output mode to all loggers in this process
      process.env.OUTPUT_MODE = program.opts().outputMode;
      const outputMode = parseOutputMode(program.opts().outputMode);
      const output = new OutputHandler({ mode: outputMode });

      output.version('Entangle Agent', getVersionInfo());

      const config = getConfig();
      const { serverUrl, pinnedCapability } = await resolveServeTarget({
        positionalUrl: url,
        capabilityFlag: options.capability,
        serverFlag: options.server,
        envCapability: process.env.ENTANGLE_CAPABILITY,
        configRelayUrl: config.relayUrl,
      });

      // `--password` with no value (commander yields `true`) prompts interactively
      // so the secret never appears in argv; a string value or AGENT_PASSWORD is
      // used verbatim.
      let password: string | undefined;
      if (options.password === true) {
        password = await promptHidden('Agent password: ');
      } else if (typeof options.password === 'string') {
        password = options.password;
      } else {
        password = process.env.AGENT_PASSWORD;
      }

      // Shared-terminal mode: on by default when attached to a real terminal,
      // forced by --shared, disabled by --headless/--no-shared. Only meaningful
      // in text mode (stream-json is for programmatic invokers).
      const isTty = !!process.stdout.isTTY && !!process.stdin.isTTY;
      const shared =
        options.headless === true ? false
        : options.shared === true ? true
        : isTty && outputMode === 'text';

      // The interactive shared path (a real terminal serving one shared session
      // in text mode) is daemonized tmux-style: a detached daemon owns the
      // session + relay connection and this process is just a client that
      // attaches to it, so closing the terminal (or Ctrl-B d) leaves the session
      // running. Every other path keeps today's in-foreground behavior below.
      if (shared && isTty && outputMode === 'text') {
        // The daemon must pin a concrete capability, so mint the ephemeral one
        // here (instead of letting startAgent mint it) when none was pinned.
        const cap: CapabilityInfo = pinnedCapability ?? await createCapability({ singleRun: false });
        const sessionName = options.session || defaultSessionName(cap.capId);

        cleanupStale();
        const existing = findSession(sessionName);

        let socket: net.Socket;
        if (existing && isAlive(existing)) {
          // Reattach to the live daemon. It may be serving a different
          // capability than the one we just resolved (e.g. a reused --session
          // name); attaching to the running one is the least surprising choice.
          if (existing.capId !== cap.capId) {
            output.info(`A session named "${sessionName}" is already running with a different capability; attaching to it.`);
          }
          socket = await connectSocket(existing.socket);
        } else {
          socket = await spawnDaemon({ sessionName, serverUrl, cap, ...(password ? { password } : {}) });
        }
        attachToSocket(socket, output);
        return; // host-terminal drives the process lifetime from here
      }

      let sharedWorkspace: SharedWorkspace | undefined;
      // The host UI (when attached) renders against a HostSession — an
      // abstraction over the workspace + log/URL sources — so the same UI can
      // later run against a socket-backed session. It sizes the active window to
      // the box interior and takes the session URL for its bottom bar once the
      // relay assigns it.
      let hostSession: LocalHostSession | undefined;
      if (shared) {
        const cols = process.stdout.columns || 80;
        const rows = process.stdout.rows || 24;
        sharedWorkspace = new SharedWorkspace(output, { cols, rows });
        if (isTty) {
          hostSession = new LocalHostSession(sharedWorkspace, output);
          attachHostTerminal(hostSession, output);
        }
      }

      await startAgent({
        serverUrl,
        outputMode: program.opts().outputMode,
        ...(password ? { password } : {}),
        ...(pinnedCapability && { pinnedCapability }),
        ...(sharedWorkspace && {
          sharedWorkspace,
          onCapabilityReady: ({ link }) => {
            if (hostSession) hostSession.setUrl(link);
            else output.info(`⧉ entangle session shared — open to collaborate:\n  ${link}\n`);
          },
        }),
      });
    } catch (error) {
      const outputMode = parseOutputMode(program.opts().outputMode);
      const output = new OutputHandler({ mode: outputMode });
      
      output.error('Failed to start agent', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command('create-cap')
  .description('Create a new capability')
  .option('--single-run', 'Allow only one run per session (default: multiple runs allowed)')
  .action(async (options) => {
    try {
      process.env.OUTPUT_MODE = program.opts().outputMode;
      const outputMode = parseOutputMode(program.opts().outputMode);
      const output = new OutputHandler({ mode: outputMode });
      
      const cap = await createCapability({
        singleRun: options.singleRun,
        outputMode: program.opts().outputMode,
      });
      
      output.info('\nCapability created:');
      output.info(`capId: ${cap.capId}`);
      output.info(`S: ${cap.S}`);
      
      const config = getConfig();
      const relayUrl = config.relayUrl || config.publicOrigin || 'https://suncoder.dev';
      const link = `${relayUrl}/cap/${cap.capId}#S=${cap.S}`;
      output.info(`\nWeb URL: ${link}`);
    } catch (error) {
      const outputMode = parseOutputMode(program.opts().outputMode);
      const output = new OutputHandler({ mode: outputMode });
      
      output.error('Failed to create capability', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command('ls')
  .alias('list')
  .description('List running serve sessions')
  .action(() => {
    const output = new OutputHandler({ mode: parseOutputMode(program.opts().outputMode) });
    cleanupStale();
    const sessions = listSessions();
    if (sessions.length === 0) { output.info('No sessions.'); return; }
    for (const s of sessions) {
      const alive = isAlive(s) ? `alive(${s.pid})` : 'dead';
      const created = new Date(s.createdAt).toISOString();
      const where = shortUrl(s.url) || s.capId;
      output.text(`${s.name}\t${alive}\t${created}\t${where}`);
    }
  });

program
  .command('kill [name]')
  .description('Kill a running session by name (SIGTERM); with no name, the only session')
  .option('--all', 'Kill every running session')
  .action((name: string | undefined, options: { all?: boolean }) => {
    const output = new OutputHandler({ mode: parseOutputMode(program.opts().outputMode) });
    cleanupStale();
    const sessions = listSessions();

    if (options.all) {
      if (sessions.length === 0) { output.info('No sessions.'); return; }
      for (const s of sessions) killSession(s, output);
      return;
    }

    let target: SessionInfo | undefined;
    if (name) {
      target = findSession(name);
      if (!target) { output.error(`No session named "${name}".`); process.exit(1); }
    } else if (sessions.length === 0) {
      output.info('No sessions.'); return;
    } else if (sessions.length === 1) {
      target = sessions[0];
    } else {
      output.error('Multiple sessions; specify one to kill (or --all):');
      for (const s of sessions) output.text(`  ${s.name}`);
      process.exit(1);
    }
    if (target) killSession(target, output);
  });

program
  .command('attach [name]')
  .description('Attach to a running session by name (or the only one) without a URL')
  .action(async (name: string | undefined) => {
    const output = new OutputHandler({ mode: parseOutputMode(program.opts().outputMode) });
    cleanupStale();
    const sessions = listSessions();

    let target: SessionInfo | undefined;
    if (name) {
      target = findSession(name);
    } else if (sessions.length === 0) {
      output.error('No sessions to attach to.'); process.exit(1);
    } else if (sessions.length === 1) {
      target = sessions[0];
    } else {
      output.error('Multiple sessions; specify one to attach to:');
      for (const s of sessions) output.text(`  ${s.name}`);
      process.exit(1);
    }

    if (!target || !isAlive(target)) {
      output.error(`No live session named "${name ?? ''}".`); process.exit(1);
    }

    try {
      const socket = await connectSocket(target.socket);
      attachToSocket(socket, output);
    } catch (error) {
      output.error('Failed to attach', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.addHelpText('after', `
Examples:
  # Mint a fresh capability and serve it on a relay
  entangle serve https://entangle.thenewlabs.com

  # Serve a specific capability (its origin is used as the relay)
  entangle serve https://entangle.thenewlabs.com/cap/<capId>#S=<secret>

  # Mint on the configured/default relay
  entangle serve

  # List / attach / kill detachable sessions
  entangle serve ls
  entangle serve attach <name>
  entangle serve kill <name>

  # Just create a capability without starting the agent
  entangle serve create-cap`);

program.parse();
}
