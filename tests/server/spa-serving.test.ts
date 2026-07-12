import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'net';
import { request } from 'http';
import type { AddressInfo, Server } from 'net';
import { startServer } from '../../relay/src/index.js';

/**
 * Boots the relay with the optional host-based SPA-serving enabled
 * (RELAY_SPA_DIR / RELAY_PREVIEW_SPA_DIR / RELAY_PREVIEW_HOST) and asserts the
 * two host roles: the view host serves the SPA (with a /cap/* catch-all), and
 * the preview host serves the preview bootstrap. /__health stays live.
 */

const PREVIEW_HOST = 'preview.locus.test';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv: Server = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Minimal HTTP GET that lets us control the Host header (fetch forbids it). */
function httpGet(
  port: number,
  path: string,
  host?: string,
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (host) headers.Host = host;
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            contentType: (res.headers['content-type'] ?? '').toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('relay optional SPA-serving (Locus)', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let port: number;
  let spaDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // A throwaway build dir mimicking locus-web/dist.
    spaDir = mkdtempSync(join(tmpdir(), 'locus-spa-'));
    writeFileSync(
      join(spaDir, 'index.html'),
      '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
    );
    writeFileSync(
      join(spaDir, 'preview.html'),
      '<!DOCTYPE html><html><head></head><body>' +
        '<meta name="locus-transport" content="__LOCUS_TRANSPORT__">' +
        '<script type="module" src="/__locus/bootstrap.js"></script></body></html>',
    );
    // The preview origin's control/static files (the SW-tunnel bridge). The relay must serve
    // these as their real files with a JS MIME, never as the HTML SPA fallback.
    mkdirSync(join(spaDir, '__locus'), { recursive: true });
    writeFileSync(join(spaDir, '__locus', 'bootstrap.js'), 'export const __locusBootstrap = 1;\n');
    writeFileSync(join(spaDir, 'sw.js'), '/* locus preview service worker */\n');

    port = await getFreePort();
    for (const k of ['PORT', 'RELAY_SPA_DIR', 'RELAY_PREVIEW_SPA_DIR', 'RELAY_PREVIEW_HOST']) {
      savedEnv[k] = process.env[k];
    }
    process.env.PORT = String(port);
    process.env.RELAY_SPA_DIR = spaDir;
    process.env.RELAY_PREVIEW_SPA_DIR = spaDir;
    process.env.RELAY_PREVIEW_HOST = PREVIEW_HOST;

    server = await startServer('text');
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(spaDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('serves the SPA index.html for a GET /cap/* catch-all on the view host', async () => {
    const res = await httpGet(port, '/cap/cap_abc123');
    expect(res.status).toBe(200);
    expect(res.body).toContain('<div id="root">');
  });

  it('serves the SPA index.html at the root of the view host', async () => {
    const res = await httpGet(port, '/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('<div id="root">');
  });

  it('keeps /__health working alongside SPA-serving', async () => {
    const res = await httpGet(port, '/__health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ok');
  });

  it('serves the preview bootstrap (not the app) on the preview host', async () => {
    const res = await httpGet(port, '/some/deep/path', PREVIEW_HOST);
    expect(res.status).toBe(200);
    expect(res.body).toContain('locus-transport');
    expect(res.body).not.toContain('<div id="root">');
  });

  it('blanks __LOCUS_TRANSPORT__ and injects the entangle client into preview.html', async () => {
    // Both the /cap/* catch-all (hard-reload heal) and the root serve the processed doc.
    const res = await httpGet(port, '/cap/cap_preview1', PREVIEW_HOST);
    expect(res.status).toBe(200);
    // Production drives the tunnel over the entangle `preview` pipe: the WS-double placeholder
    // must be blanked so bootstrap does not take the WebSocket path.
    expect(res.body).not.toContain('__LOCUS_TRANSPORT__');
    expect(res.body).toContain('content=""');
    // The preview origin needs window.entangle to open its own `preview` pipe.
    expect(res.body).toContain('/__entangle-client.js');
  });

  it('serves /__entangle-client.js as JS on the preview host', async () => {
    const res = await httpGet(port, '/__entangle-client.js', PREVIEW_HOST);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('javascript');
  });

  it('serves /__locus/bootstrap.js as JS (not the HTML fallback) on the preview host', async () => {
    const res = await httpGet(port, '/__locus/bootstrap.js', PREVIEW_HOST);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('javascript');
    expect(res.body).toContain('__locusBootstrap');
    expect(res.body).not.toContain('locus-transport');
  });

  it('serves /sw.js as JS (not the HTML fallback) on the preview host', async () => {
    const res = await httpGet(port, '/sw.js', PREVIEW_HOST);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('javascript');
    expect(res.body).toContain('service worker');
  });

  it('404s a missing /__locus/* on the preview host instead of serving HTML', async () => {
    const res = await httpGet(port, '/__locus/does-not-exist.js', PREVIEW_HOST);
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('locus-transport');
  });

  it('serves the app (not the preview bootstrap) on a non-preview host', async () => {
    const res = await httpGet(port, '/anything', 'locus.locus.test');
    expect(res.status).toBe(200);
    expect(res.body).toContain('<div id="root">');
  });
});
