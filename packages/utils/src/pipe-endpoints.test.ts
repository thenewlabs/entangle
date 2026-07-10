import { describe, it, expect, afterEach } from 'vitest';
import { parsePipeEndpoints, getConfig } from './config.js';

describe('parsePipeEndpoints', () => {
  it('parses a unix endpoint spec', () => {
    const map = parsePipeEndpoints(['glass=unix:/tmp/glass.sock']);
    expect(map.get('glass')).toEqual({ kind: 'unix', path: '/tmp/glass.sock' });
  });

  it('parses a tcp endpoint spec', () => {
    const map = parsePipeEndpoints(['preview=tcp:127.0.0.1:7060']);
    expect(map.get('preview')).toEqual({ kind: 'tcp', host: '127.0.0.1', port: 7060 });
  });

  it('parses multiple specs into one map', () => {
    const map = parsePipeEndpoints([
      'glass=unix:/tmp/glass.sock',
      'preview=tcp:localhost:8080',
    ]);
    expect(map.size).toBe(2);
    expect(map.get('glass')).toEqual({ kind: 'unix', path: '/tmp/glass.sock' });
    expect(map.get('preview')).toEqual({ kind: 'tcp', host: 'localhost', port: 8080 });
  });

  it('ignores blank entries', () => {
    const map = parsePipeEndpoints(['', '  ', 'glass=unix:/tmp/glass.sock']);
    expect(map.size).toBe(1);
  });

  it('rejects a spec with no target', () => {
    expect(() => parsePipeEndpoints(['glass'])).toThrow(/Malformed pipe spec/);
  });

  it('rejects a spec with an empty name', () => {
    expect(() => parsePipeEndpoints(['=unix:/tmp/x.sock'])).toThrow(/Malformed pipe spec/);
  });

  it('rejects an unknown scheme', () => {
    expect(() => parsePipeEndpoints(['glass=http:/tmp/x.sock'])).toThrow(/unix: or tcp:/);
  });

  it('rejects an empty unix path', () => {
    expect(() => parsePipeEndpoints(['glass=unix:'])).toThrow(/empty unix path/);
  });

  it('rejects a tcp target without a port', () => {
    expect(() => parsePipeEndpoints(['glass=tcp:127.0.0.1'])).toThrow(/tcp:host:port/);
  });

  it('rejects a non-numeric tcp port', () => {
    expect(() => parsePipeEndpoints(['glass=tcp:127.0.0.1:abc'])).toThrow(/invalid tcp port/);
  });

  it('rejects an out-of-range tcp port', () => {
    expect(() => parsePipeEndpoints(['glass=tcp:127.0.0.1:70000'])).toThrow(/invalid tcp port/);
  });

  it('rejects a duplicate pipe name', () => {
    expect(() => parsePipeEndpoints([
      'glass=unix:/tmp/a.sock',
      'glass=unix:/tmp/b.sock',
    ])).toThrow(/Duplicate pipe name/);
  });
});

describe('config ENTANGLE_PIPES', () => {
  afterEach(() => {
    delete process.env.ENTANGLE_PIPES;
    process.env.NODE_ENV = 'test';
  });

  it('parses comma- and space-separated pipe specs from the env', () => {
    process.env.ENTANGLE_PIPES = 'glass=unix:/tmp/glass.sock, preview=tcp:127.0.0.1:7060';
    const eps = getConfig().pipeEndpoints;
    expect(eps.get('glass')).toEqual({ kind: 'unix', path: '/tmp/glass.sock' });
    expect(eps.get('preview')).toEqual({ kind: 'tcp', host: '127.0.0.1', port: 7060 });
  });

  it('yields an empty map (never throws) on a malformed env value', () => {
    process.env.ENTANGLE_PIPES = 'this-is-not-valid';
    expect(getConfig().pipeEndpoints.size).toBe(0);
  });

  it('defaults to an empty map when unset', () => {
    expect(getConfig().pipeEndpoints.size).toBe(0);
  });
});
