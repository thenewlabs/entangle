import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveRunDir,
  ensureRunDir,
  sanitizeName,
  socketPath,
  logPath,
  defaultSessionName,
  addSession,
  removeSession,
  listSessions,
  findSession,
  isAlive,
  cleanupStale,
  waitForSessionUrl,
  assertSocketPathUsable,
  MAX_SOCKET_PATH_BYTES,
  type SessionInfo,
} from './session-registry.js';

let runDir: string;
const savedRunDir = process.env.ENTANGLE_RUN_DIR;

beforeEach(() => {
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entangle-reg-'));
  process.env.ENTANGLE_RUN_DIR = runDir;
});

afterEach(() => {
  if (savedRunDir === undefined) delete process.env.ENTANGLE_RUN_DIR;
  else process.env.ENTANGLE_RUN_DIR = savedRunDir;
  fs.rmSync(runDir, { recursive: true, force: true });
});

function makeInfo(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    name: 'demo',
    socket: socketPath('demo'),
    logFile: logPath('demo'),
    pid: process.pid,
    capId: 'cap0123456789',
    url: 'https://example.test/demo',
    createdAt: Date.now(),
    ...over,
  };
}

describe('run dir resolution', () => {
  it('honors ENTANGLE_RUN_DIR before XDG_RUNTIME_DIR', () => {
    const savedXdg = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = '/some/xdg';
    try {
      expect(resolveRunDir()).toBe(runDir);
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = savedXdg;
    }
  });

  it('falls back to $XDG_RUNTIME_DIR/entangle when no override', () => {
    delete process.env.ENTANGLE_RUN_DIR;
    const savedXdg = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = '/run/user/1000';
    try {
      expect(resolveRunDir()).toBe(path.join('/run/user/1000', 'entangle'));
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = savedXdg;
    }
  });

  it('creates the run dir 0700 when missing', () => {
    const nested = path.join(runDir, 'sub', 'run');
    process.env.ENTANGLE_RUN_DIR = nested;
    const dir = ensureRunDir();
    expect(dir).toBe(nested);
    const mode = fs.statSync(nested).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

describe('path helpers', () => {
  it('sanitizes names to [A-Za-z0-9._-]', () => {
    expect(sanitizeName('a/b c:d')).toBe('a-b-c-d');
    expect(sanitizeName('ok.name-1_2')).toBe('ok.name-1_2');
    expect(sanitizeName('')).toBe('session');
    expect(sanitizeName('..')).toBe('session');
  });

  it('socketPath/logPath are deterministic and land in the run dir', () => {
    expect(socketPath('my sess')).toBe(path.join(runDir, 'my-sess.sock'));
    expect(logPath('my sess')).toBe(path.join(runDir, 'my-sess.log'));
    expect(socketPath('x')).toBe(socketPath('x'));
  });

  it('defaultSessionName is stable and derived from capId', () => {
    const cap = 'AbC123-xyz-9876543210';
    expect(defaultSessionName(cap)).toBe(defaultSessionName(cap));
    expect(defaultSessionName(cap)).toMatch(/^cap-[A-Za-z0-9]{1,10}$/);
    expect(defaultSessionName('a')).not.toBe(defaultSessionName('b'));
  });

  it('assertSocketPathUsable rejects paths bind() would truncate', () => {
    expect(() => assertSocketPathUsable('/short/path.sock')).not.toThrow();
    expect(() => assertSocketPathUsable('x'.repeat(MAX_SOCKET_PATH_BYTES))).not.toThrow();
    expect(() => assertSocketPathUsable(`/${'x'.repeat(MAX_SOCKET_PATH_BYTES)}.sock`)).toThrow(/too long/);
    // Byte length, not char count: multi-byte characters hit the limit sooner.
    expect(() => assertSocketPathUsable('/ü'.repeat(40))).toThrow(/too long/);
  });
});

describe('registry CRUD', () => {
  it('add / find / list / remove', () => {
    expect(listSessions()).toEqual([]);
    const a = makeInfo({ name: 'a' });
    const b = makeInfo({ name: 'b' });
    addSession(a);
    addSession(b);
    expect(listSessions()).toHaveLength(2);
    expect(findSession('a')).toEqual(a);
    expect(findSession('nope')).toBeUndefined();
    removeSession('a');
    expect(findSession('a')).toBeUndefined();
    expect(listSessions()).toEqual([b]);
    removeSession('does-not-exist'); // no throw
  });

  it('replaces an existing session with the same name', () => {
    addSession(makeInfo({ name: 'dup', url: 'first' }));
    addSession(makeInfo({ name: 'dup', url: 'second' }));
    expect(listSessions()).toHaveLength(1);
    expect(findSession('dup')?.url).toBe('second');
  });

  it('treats a missing registry file as empty', () => {
    expect(listSessions()).toEqual([]);
  });

  it('treats a corrupt registry file as empty', () => {
    ensureRunDir();
    fs.writeFileSync(path.join(runDir, 'sessions.json'), '{ not json');
    expect(listSessions()).toEqual([]);
  });
});

describe('additive schema (kind / workspaceRoot)', () => {
  it('round-trips kind and workspaceRoot', () => {
    addSession(makeInfo({ name: 'lo', kind: 'locus', workspaceRoot: '/w/space' }));
    const got = findSession('lo');
    expect(got?.kind).toBe('locus');
    expect(got?.workspaceRoot).toBe('/w/space');
  });

  it('still lists legacy entries written without the new fields', () => {
    ensureRunDir();
    const legacy = makeInfo({ name: 'old' });
    delete (legacy as Record<string, unknown>).kind;
    delete (legacy as Record<string, unknown>).workspaceRoot;
    fs.writeFileSync(path.join(runDir, 'sessions.json'), JSON.stringify([legacy]));
    const got = findSession('old');
    expect(got).toBeDefined();
    expect(got?.kind).toBeUndefined();
  });

  it('filters entries with a bogus kind value', () => {
    ensureRunDir();
    const bogus = { ...makeInfo({ name: 'weird' }), kind: 'container' };
    fs.writeFileSync(path.join(runDir, 'sessions.json'), JSON.stringify([bogus, makeInfo({ name: 'fine' })]));
    expect(listSessions().map((s) => s.name)).toEqual(['fine']);
  });
});

describe('waitForSessionUrl', () => {
  it('resolves once the session gains a url', async () => {
    addSession(makeInfo({ name: 'pending', url: '' }));
    setTimeout(() => addSession(makeInfo({ name: 'pending', url: 'https://relay.test/cap/x#S=y' })), 150);
    await expect(waitForSessionUrl('pending', 4000)).resolves.toBe('https://relay.test/cap/x#S=y');
  });

  it("resolves '' when no url appears in time", async () => {
    addSession(makeInfo({ name: 'stuck', url: '' }));
    await expect(waitForSessionUrl('stuck', 300)).resolves.toBe('');
  });

  it("resolves '' for a session that does not exist", async () => {
    await expect(waitForSessionUrl('ghost', 300)).resolves.toBe('');
  });
});

describe('liveness', () => {
  it('isAlive true for current pid with an existing socket', () => {
    const sock = socketPath('live');
    ensureRunDir();
    fs.writeFileSync(sock, '');
    expect(isAlive(makeInfo({ name: 'live', socket: sock, pid: process.pid }))).toBe(true);
  });

  it('isAlive false for a bogus pid', () => {
    const sock = socketPath('dead');
    ensureRunDir();
    fs.writeFileSync(sock, '');
    expect(isAlive(makeInfo({ socket: sock, pid: 2147483646 }))).toBe(false);
  });

  it('isAlive false when the socket is missing even if pid is alive', () => {
    expect(isAlive(makeInfo({ socket: socketPath('gone'), pid: process.pid }))).toBe(false);
  });

  it('cleanupStale removes dead entries and orphan sockets', () => {
    ensureRunDir();
    const liveSock = socketPath('alive');
    const deadSock = socketPath('deadproc');
    const orphanSock = path.join(runDir, 'orphan.sock');
    fs.writeFileSync(liveSock, '');
    fs.writeFileSync(deadSock, '');
    fs.writeFileSync(orphanSock, '');

    addSession(makeInfo({ name: 'alive', socket: liveSock, pid: process.pid }));
    addSession(makeInfo({ name: 'deadproc', socket: deadSock, pid: 2147483646 }));

    cleanupStale();

    // Dead registry entry pruned, live one kept.
    expect(listSessions().map((s) => s.name)).toEqual(['alive']);
    // Orphan + dead-owner sockets unlinked, live socket kept.
    expect(fs.existsSync(liveSock)).toBe(true);
    expect(fs.existsSync(deadSock)).toBe(false);
    expect(fs.existsSync(orphanSock)).toBe(false);
  });
});
