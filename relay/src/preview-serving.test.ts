import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { startServer } from './index.js';

/**
 * Preview-host serving invariant: the SPA fallback must NEVER answer a tunnel-only
 * `/__locus-nav/*` SUBRESOURCE request with the bootstrap HTML. Doing so MIME-lies — a
 * `<script>` for a cross-origin dev-server asset (`/__locus-nav/http/localhost:5174/…app.js`)
 * receives `text/html` and fails as "Failed to load script" (the multi-preview asset bug). A
 * DOCUMENT navigation in that namespace (a browse-mode hard reload) still gets the bootstrap so
 * it heals back onto the Service Worker. Reproduces the curl-confirmed bug and locks the fix.
 */

const PORT = 8231;
const HOST = '127.0.0.1';
const PREVIEW_HOST = 'preview.locus.test';

/** GET `path` with an explicit Host + optional Sec-Fetch-* headers (fetch forbids setting Host). */
function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: HOST, port: PORT, path, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('preview-host SPA fallback', () => {
  let server: Server;
  let spaDir: string;

  beforeAll(async () => {
    spaDir = mkdtempSync(join(tmpdir(), 'relay-preview-'));
    mkdirSync(join(spaDir, 'assets'));
    writeFileSync(join(spaDir, 'index.html'), '<!doctype html><title>view spa</title>');
    writeFileSync(join(spaDir, 'preview.html'), '<!doctype html><title>preview bootstrap</title>');
    writeFileSync(join(spaDir, 'sw.js'), 'self.addEventListener("install",()=>{});');
    writeFileSync(join(spaDir, 'assets', 'app-abc123.js'), 'console.log("built asset");');

    process.env.PORT = String(PORT);
    process.env.HOST = HOST;
    process.env.RELAY_SPA_DIR = spaDir;
    process.env.RELAY_PREVIEW_HOST = PREVIEW_HOST;

    server = await startServer('json');
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(spaDir, { recursive: true, force: true });
    delete process.env.RELAY_SPA_DIR;
    delete process.env.RELAY_PREVIEW_HOST;
  });

  const asPreview = { host: `p1qsya13.${PREVIEW_HOST}` };

  it('404s a nav-encoded dev-server asset (script subresource) instead of the bootstrap', async () => {
    const res = await get('/__locus-nav/http/localhost:5174/resources/js/app.js', {
      ...asPreview,
      'sec-fetch-dest': 'script',
      'sec-fetch-mode': 'no-cors',
    });
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('preview bootstrap');
  });

  it('404s a nav-encoded stylesheet subresource', async () => {
    const res = await get('/__locus-nav/http/localhost:5174/resources/css/app.css', {
      ...asPreview,
      'sec-fetch-dest': 'style',
      'sec-fetch-mode': 'no-cors',
    });
    expect(res.status).toBe(404);
  });

  it('404s a nav-encoded request with NO Sec-Fetch-* (treated as subresource)', async () => {
    const res = await get('/__locus-nav/http/localhost:5174/resources/js/app.js', asPreview);
    expect(res.status).toBe(404);
  });

  it('still serves the bootstrap for a nav-encoded DOCUMENT navigation (heal path)', async () => {
    const res = await get('/__locus-nav/https/example.com/some/page', {
      ...asPreview,
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
    });
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/html');
    expect(res.body).toContain('preview bootstrap');
  });

  it('serves the bootstrap for a top-level document navigation to the preview root', async () => {
    const res = await get('/', {
      ...asPreview,
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
    });
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/html');
    expect(res.body).toContain('preview bootstrap');
  });

  it('serves /sw.js as its real self, never the HTML fallback', async () => {
    const res = await get('/sw.js', asPreview);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('javascript');
    expect(res.body).toContain('install');
  });

  it('404s a missing /assets/* file rather than masquerading as HTML', async () => {
    const res = await get('/assets/does-not-exist.js', asPreview);
    expect(res.status).toBe(404);
  });
});
