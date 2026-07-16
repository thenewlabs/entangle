import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Discovery + on-disk bookkeeping for running `entangle serve` daemon sessions.
//
// Everything lives under a per-user runtime directory (see resolveRunDir):
//   <dir>/<name>.sock       unix socket a client attaches to
//   <dir>/<name>.log        session log file
//   <dir>/sessions.json     registry of known sessions (SessionInfo[])
//
// The directory is created 0700 so the sockets inside are only reachable by the
// owning user — that filesystem permission is what secures the (unencrypted)
// local IPC transport in ipc.ts.

/** A registered, discoverable daemon session. */
export interface SessionInfo {
  name: string;
  socket: string;
  logFile: string;
  pid: number;
  capId: string;
  url: string;
  createdAt: number;
  /** What runs the session. Absent on entries written by older builds = 'entangle'. */
  kind?: 'entangle' | 'locus';
  /** The workspace directory a locus session serves. */
  workspaceRoot?: string;
}

const REGISTRY_FILE = 'sessions.json';

/**
 * Resolve the runtime directory holding sockets, logs and the registry.
 *
 * Precedence:
 *   1. `ENTANGLE_RUN_DIR` — explicit override (used by tests, and handy for the
 *      daemon to pin a location);
 *   2. `$XDG_RUNTIME_DIR/entangle` — the standard per-user runtime dir;
 *   3. `~/.entangle/run` — fallback when XDG is unset.
 */
export function resolveRunDir(): string {
  const override = process.env.ENTANGLE_RUN_DIR;
  if (override) return override;
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return path.join(xdg, 'entangle');
  return path.join(os.homedir(), '.entangle', 'run');
}

/** Ensure the runtime directory exists with 0700 perms, returning its path. */
export function ensureRunDir(): string {
  const dir = resolveRunDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Reduce an arbitrary name to a filesystem-safe token ([A-Za-z0-9._-]). */
export function sanitizeName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '-');
  // Avoid an empty basename or a name that resolves to a directory entry.
  return safe.length > 0 && safe !== '.' && safe !== '..' ? safe : 'session';
}

/**
 * Maximum usable byte length of a unix socket path: sun_path is 108 bytes on
 * Linux and 104 on macOS/BSD, both including the trailing NUL. A longer path
 * is silently TRUNCATED by bind/connect — the daemon ends up listening on a
 * different file than the registry records, so liveness checks report dead
 * sessions and reattach logic double-spawns. Fail closed at the conservative
 * cross-platform bound instead.
 */
export const MAX_SOCKET_PATH_BYTES = 103;

/** Throw a clear configuration error if `path` cannot be bound un-truncated. */
export function assertSocketPathUsable(sockPath: string): void {
  const bytes = Buffer.byteLength(sockPath);
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `Unix socket path too long (${bytes} > ${MAX_SOCKET_PATH_BYTES} bytes): ${sockPath} — ` +
      'set ENTANGLE_RUN_DIR to a shorter directory',
    );
  }
}

/** Absolute path of the unix socket for a session. */
export function socketPath(name: string): string {
  return path.join(resolveRunDir(), `${sanitizeName(name)}.sock`);
}

/** Absolute path of the log file for a session. */
export function logPath(name: string): string {
  return path.join(resolveRunDir(), `${sanitizeName(name)}.log`);
}

/**
 * Stable short session name derived from a capability id, so an unnamed session
 * is keyed on its capability. Deterministic: the same capId always yields the
 * same name. Uses the sanitized leading characters of the capId (capIds are
 * already url-safe base-ish tokens) to stay human-recognizable.
 */
export function defaultSessionName(capId: string): string {
  const token = sanitizeName(capId).replace(/[._-]/g, '').slice(0, 10) || 'anon';
  return `cap-${token}`;
}

// --- registry file I/O (best-effort, tolerant of missing/corrupt data) -----

function registryPath(): string {
  return path.join(resolveRunDir(), REGISTRY_FILE);
}

function isSessionInfo(value: unknown): value is SessionInfo {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    typeof v.socket === 'string' &&
    typeof v.logFile === 'string' &&
    typeof v.pid === 'number' &&
    typeof v.capId === 'string' &&
    typeof v.url === 'string' &&
    typeof v.createdAt === 'number' &&
    // Optional additive fields (absent on entries from older builds).
    (v.kind === undefined || v.kind === 'entangle' || v.kind === 'locus') &&
    (v.workspaceRoot === undefined || typeof v.workspaceRoot === 'string')
  );
}

/** Read the registry. A missing or corrupt file is treated as empty. */
export function listSessions(): SessionInfo[] {
  let raw: string;
  try {
    raw = fs.readFileSync(registryPath(), 'utf8');
  } catch {
    return []; // missing file (or unreadable) → no sessions
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSessionInfo);
  } catch {
    return []; // corrupt JSON → treat as empty
  }
}

function writeSessions(sessions: SessionInfo[]): void {
  ensureRunDir();
  const tmp = `${registryPath()}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, registryPath()); // atomic replace
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
  }
}

/** Add (or replace by name) a session in the registry. */
export function addSession(info: SessionInfo): void {
  const sessions = listSessions().filter((s) => s.name !== info.name);
  sessions.push(info);
  writeSessions(sessions);
}

/** Remove a session from the registry by name. No-op if absent. */
export function removeSession(name: string): void {
  const sessions = listSessions();
  const next = sessions.filter((s) => s.name !== name);
  if (next.length !== sessions.length) writeSessions(next);
}

/** Find a registered session by name. */
export function findSession(name: string): SessionInfo | undefined {
  return listSessions().find((s) => s.name === name);
}

/**
 * Poll the registry until the named session has a URL (the daemon re-registers
 * with the link once the relay announces the capability). Resolves the URL, or
 * '' if none appears within `timeoutMs` — callers treat that as "URL pending",
 * not an error, since the daemon may still be connecting to its relay.
 */
export async function waitForSessionUrl(name: string, timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const url = findSession(name)?.url;
    if (url) return url;
    if (Date.now() >= deadline) return '';
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// --- liveness --------------------------------------------------------------

/** True if the pid is alive AND the session's socket file still exists. */
export function isAlive(info: SessionInfo): boolean {
  return pidAlive(info.pid) && fs.existsSync(info.socket);
}

/** True if a process with `pid` exists and is signalable by us. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we may not signal it → still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Prune dead state: drop registry entries whose pid is gone, and unlink any
 * `.sock` file in the run dir that no live registered session owns.
 */
export function cleanupStale(): void {
  const dir = resolveRunDir();
  const sessions = listSessions();
  const live = sessions.filter((s) => pidAlive(s.pid));
  if (live.length !== sessions.length) writeSessions(live);

  const liveSockets = new Set(live.map((s) => s.socket));

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // dir gone → nothing to unlink
  }
  for (const entry of entries) {
    if (!entry.endsWith('.sock')) continue;
    const full = path.join(dir, entry);
    if (liveSockets.has(full)) continue; // owned by a live session
    try { fs.unlinkSync(full); } catch { /* raced / already gone */ }
  }
}
