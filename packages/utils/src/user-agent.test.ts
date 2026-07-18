import { readFileSync } from 'fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildUserAgent, userAgentHeaders, USER_AGENT_URL } from './user-agent.js';

// Node sends no User-Agent by default (neither `fetch` nor `ws`). A UA-less request logs as "-"
// upstream, and a reconnect loop of those reads as bot traffic — CrowdSec banned the box for
// exactly that against /agent/register. These tests pin the shape of the header we now send.

const REPO_ROOT = resolve(new URL('../../..', import.meta.url).pathname);

function manifestVersion(pkgDir: string): string {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, pkgDir, 'package.json'), 'utf8')).version;
}

function entryUrlFor(pkgDir: string): string {
  return pathToFileURL(resolve(REPO_ROOT, pkgDir, 'src', 'index.ts')).href;
}

describe('buildUserAgent', () => {
  it('is non-empty and carries product, version and project URL', () => {
    const ua = buildUserAgent('entangle-serve', entryUrlFor('serve'));
    expect(ua).toBe(`entangle-serve/${manifestVersion('serve')} (+${USER_AGENT_URL})`);
    expect(ua.length).toBeGreaterThan(0);
  });

  it('derives the version from the calling package, not a hardcoded literal', () => {
    expect(buildUserAgent('entangle-connect', entryUrlFor('connect')))
      .toContain(`/${manifestVersion('connect')}`);
  });

  it('distinguishes the components so a relay operator can tell them apart', () => {
    const serve = buildUserAgent('entangle-serve', entryUrlFor('serve'));
    const connect = buildUserAgent('entangle-connect', entryUrlFor('connect'));
    expect(serve).not.toBe(connect);
    expect(serve.startsWith('entangle-serve/')).toBe(true);
    expect(connect.startsWith('entangle-connect/')).toBe(true);
  });

  it('is a valid single-line HTTP header value', () => {
    const ua = buildUserAgent('entangle-serve', entryUrlFor('serve'));
    // No CR/LF (header injection), no control chars, all printable ASCII.
    expect(ua).toMatch(/^[\x20-\x7e]+$/);
    expect(ua).not.toMatch(/[\r\n]/);
  });

  it('stays well-formed when the manifest cannot be read', () => {
    const ua = buildUserAgent('entangle-serve', 'file:///nonexistent/dir/index.js');
    expect(ua).toBe(`entangle-serve/unknown (+${USER_AGENT_URL})`);
  });

  it('leaks nothing beyond product and version', () => {
    const ua = buildUserAgent('entangle-serve', entryUrlFor('serve'));
    expect(ua).not.toContain(REPO_ROOT);
    expect(ua).not.toMatch(/#S=|token|secret|capId/i);
  });
});

describe('userAgentHeaders', () => {
  it('uses a lowercase key so `ws` does not emit a duplicate header', () => {
    const headers = userAgentHeaders('entangle-serve', entryUrlFor('serve'));
    expect(Object.keys(headers)).toEqual(['user-agent']);
    expect(headers['user-agent']).toBe(buildUserAgent('entangle-serve', entryUrlFor('serve')));
  });
});
