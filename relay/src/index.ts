#!/usr/bin/env node

import { Command } from 'commander';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer, type Server } from 'http';
import { getConfig, getVersionInfo, OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';
import { setupAgentRoute } from './routes/agent.js';
import { setupRelayRoute } from './routes/relay.js';
import { RoutingState } from './state/routing.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, realpathSync, readFileSync } from 'fs';
import { wsRateLimiter } from './utils/rate-limit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Robust "am I the entry point?" check. Comparing import.meta.url to
 * `file://${process.argv[1]}` breaks when invoked through an npm bin symlink
 * (argv[1] is the symlink path). Resolve realpaths on both sides so the CLI
 * actually starts instead of no-opping with exit 0.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const invoked = realpathSync(entry);
    return self === invoked;
  } catch {
    return false;
  }
}

/**
 * Resolve the entangle browser-client IIFE bundle for injection into the served
 * SPA. Primary path: the prebuilt `dist/entangle-client.js` produced by
 * `npm run build` (so production never esbuilds at request time). Dev fallback
 * (`npm run dev` / tsx, where no prebuilt artifact exists): esbuild the source
 * once at startup. Returns null if neither is available.
 */
async function loadEntangleClient(output: OutputHandler): Promise<string | null> {
  const prebuiltCandidates = [
    join(__dirname, 'entangle-client.js'), // dist/relay.js sibling (production)
    join(__dirname, '../../dist/entangle-client.js'), // tsx relay/src/index.ts
    join(__dirname, '../dist/entangle-client.js'),
  ];
  for (const candidate of prebuiltCandidates) {
    if (existsSync(candidate)) {
      try {
        return readFileSync(candidate, 'utf8');
      } catch {
        /* try next */
      }
    }
  }

  // Dev-only fallback: bundle the source on the fly. Keep esbuild out of the
  // production relay bundle by resolving the module name indirectly so the
  // bundler cannot statically inline it.
  const webRoot = join(__dirname, '../../web');
  const entry = join(webRoot, 'src', 'window-entangle-spawn.ts');
  if (!existsSync(entry)) return null;
  try {
    const esbuildName = 'esbuild';
    const esbuild: any = await import(esbuildName);
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: 'iife',
      target: 'es2020',
      write: false,
      absWorkingDir: webRoot,
    });
    output.info('Entangle client bundled on the fly (dev fallback; no prebuilt dist/entangle-client.js)');
    return result.outputFiles?.[0]?.text ?? null;
  } catch (err) {
    output.warn(`Entangle client esbuild fallback failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function startServer(outputMode: string = 'text'): Promise<Server> {
  // Ensure all loggers in this process share the same output mode
  process.env.OUTPUT_MODE = outputMode;
  const output = new OutputHandler({ mode: parseOutputMode(outputMode) });
  output.version('Entangle Server', getVersionInfo());
  
  const config = getConfig();
  const app = express();
  const server = createServer(app);
  
  const routing = new RoutingState();

  // CORS is disabled by default (same-origin only). Set CORS_ORIGINS to a
  // comma-separated allow-list to opt specific origins in.
  if (config.corsOrigins.length > 0) {
    app.use(cors({ origin: config.corsOrigins }));
  }

  const previewHost = (process.env.RELAY_PREVIEW_HOST || '').trim().toLowerCase();

  // The Locus view frames the preview origin (RELAY_PREVIEW_HOST) in an iframe.
  // With a bare `default-src 'self'` the browser blocks that frame, so widen
  // ONLY framing to the preview host. Allow both http and https on any port so
  // the same derivation works locally (preview.localhost:8080) and in prod
  // (preview.locus.thenewlabs.com over https). Nothing else is broadened.
  const frameSources = previewHost
    ? ["'self'", `http://${previewHost}:*`, `https://${previewHost}:*`]
    : ["'self'"];

  const isPreviewHostReq = (req: express.Request): boolean => {
    if (!previewHost) return false;
    const host = (req.headers.host ?? '').split(':')[0]?.trim().toLowerCase() ?? '';
    return host === previewHost;
  };

  // Framing needs BOTH sides to agree: the VIEW page's `frame-src` (above) lets
  // it embed the preview iframe, but the PREVIEW response must also permit being
  // framed via `frame-ancestors`. Compute the allowed view origin(s) that may
  // frame the preview: an explicit `RELAY_VIEW_ORIGIN` (comma-separated) if set,
  // else derive it from the request — the preview host is conventionally a
  // `preview.` subdomain of the view host, so strip that prefix and keep the
  // request scheme + host:port (e.g. preview.localhost:8080 → localhost:8080,
  // preview.locus.thenewlabs.com → locus.thenewlabs.com over https).
  const viewOriginsForPreview = (req: express.Request): string[] => {
    const env = (process.env.RELAY_VIEW_ORIGIN || '').trim();
    if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
    const host = (req.headers.host ?? '').trim();
    if (!host) return [];
    const xfProto = ((req.headers['x-forwarded-proto'] as string) || '').split(',')[0]?.trim();
    const scheme = xfProto || req.protocol || 'http';
    const viewHost = host.replace(/^preview\./i, '');
    return [`${scheme}://${viewHost}`];
  };

  // Security headers for the served SPA. A strict CSP limits the blast radius
  // of any injected script (the capability secret lives in JS-reachable state).
  app.use((req, res, next) => {
    // The VIEW host is never framable (frame-ancestors 'none'); the PREVIEW
    // host must allow the view origin to frame it, and only that.
    const frameAncestors = isPreviewHostReq(req)
      ? `frame-ancestors 'self' ${viewOriginsForPreview(req).join(' ')}`.trimEnd()
      : "frame-ancestors 'none'";
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "connect-src 'self' ws: wss:",
        "img-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self' 'wasm-unsafe-eval'",
        // Same-origin service worker (Locus preview bridge / SW tunnel).
        "worker-src 'self'",
        // Allow framing the preview origin (both frame-src and the legacy
        // child-src fallback so older engines honour it too).
        `frame-src ${frameSources.join(' ')}`,
        `child-src ${frameSources.join(' ')}`,
        "base-uri 'none'",
        frameAncestors,
        "object-src 'none'",
      ].join('; ')
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use(express.json());

  app.get('/__health', (_req, res) => {
    res.json({ status: 'ok', agents: routing.getAgentCount() });
  });
  
  // ---------------------------------------------------------------------------
  // Optional host-based SPA-serving (Locus deployment; OFF by default).
  //
  // When RELAY_SPA_DIR is set, the relay ALSO becomes the origin that serves the
  // single-page app — so the SPA dials the WS relay at its own origin (the
  // entangle model). Two host roles are distinguished by the `Host` header:
  //
  //   view host    (any non-preview Host): serves the SPA. GET /cap/<id> is a
  //                catch-all → index.html, so the client reads capId + secret
  //                from the URL (the #S= fragment never reaches the server).
  //   preview host (Host === RELAY_PREVIEW_HOST): serves the preview bootstrap
  //                (RELAY_PREVIEW_DOC, default preview.html) as its catch-all,
  //                so hard reloads heal back onto the Service-Worker bridge.
  //
  // Both dirs typically point at the SAME locus-web build (it ships index.html,
  // preview.html, sw.js and assets/). This block is a no-op unless RELAY_SPA_DIR
  // is set, so existing entangle web-serving (below) is unchanged.
  // ---------------------------------------------------------------------------
  const spaDir = process.env.RELAY_SPA_DIR;
  const previewDoc = process.env.RELAY_PREVIEW_DOC || 'preview.html';

  let spaServed = false;
  if (spaDir) {
    if (!existsSync(join(spaDir, 'index.html'))) {
      output.warn(`RELAY_SPA_DIR set but no index.html at ${spaDir}; SPA-serving disabled`);
    } else {
      // spaDir is narrowed to string here; the preview dir defaults to it.
      const viewDir: string = spaDir;
      const previewDir: string = process.env.RELAY_PREVIEW_SPA_DIR || spaDir;
      spaServed = true;
      output.info(`Serving SPA from ${viewDir}`);
      if (previewHost) {
        output.info(`Preview host ${previewHost} serves ${previewDoc} from ${previewDir}`);
      }

      const isPreviewHost = (req: express.Request): boolean => {
        if (!previewHost) return false;
        const host = (req.headers.host ?? '').split(':')[0]?.trim().toLowerCase() ?? '';
        return host === previewHost;
      };

      // The Locus VIEW SPA expects a global `window.entangle` (openPipe /
      // openTerminal) to already exist — it is provided by entangle's browser
      // client, which parses capId from the path and the secret from the #S=
      // fragment as a module-load side effect. Inject it into the served view
      // index.html as a same-origin classic script (CSP 'self' allows it, and
      // the secret never leaves the browser) so it runs BEFORE the SPA's
      // deferred module. The preview origin uses the Service-Worker tunnel, not
      // window.entangle, so it is deliberately NOT injected.
      const entangleClientJs = await loadEntangleClient(output);
      const rawIndexHtml = readFileSync(join(viewDir, 'index.html'), 'utf8');
      const viewIndexHtml = entangleClientJs
        ? rawIndexHtml.replace(
            '</head>',
            '  <script src="/__entangle-client.js"></script>\n</head>',
          )
        : rawIndexHtml;
      if (!entangleClientJs) {
        output.warn(
          'Entangle client bundle unavailable (no dist/entangle-client.js and esbuild fallback failed); ' +
            'served SPA will not have window.entangle',
        );
      }

      // Serve the entangle client bundle (view origin only; same-origin).
      app.get('/__entangle-client.js', (req, res, next) => {
        if (isPreviewHost(req)) return next();
        if (!entangleClientJs) return res.status(404).end();
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.send(entangleClientJs);
      });

      // The view document itself (/, /index.html) must carry the injected
      // client, so intercept it BEFORE the static handler (which would
      // otherwise serve the un-injected file). Preview host falls through.
      app.get(['/', '/index.html'], (req, res, next) => {
        if (isPreviewHost(req)) return next();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(viewIndexHtml);
      });

      // `index: false` on the view static so `/` reaches the handler above
      // instead of auto-serving the un-injected index.html.
      const viewStatic = express.static(viewDir, { index: false });
      const previewStatic = express.static(previewDir);

      // Static assets: preview host reads from the preview dir, everyone else
      // from the view dir (usually the same directory).
      app.use((req, res, next) => {
        if (isPreviewHost(req)) return previewStatic(req, res, next);
        return viewStatic(req, res, next);
      });

      // SPA fallback for client-side routing. Express 5 / path-to-regexp v8
      // rejects a bare '*' path, so use a terminal middleware for unmatched
      // GETs. The document depends on the host role. The view catch-all (e.g.
      // /cap/<id>) returns the index with the entangle client injected.
      app.use((req, res, next) => {
        if (req.method !== 'GET') return next();
        if (isPreviewHost(req)) return res.sendFile(join(previewDir, previewDoc));
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(viewIndexHtml);
      });
    }
  }

  // Entangle's own bundled web UI (unchanged). Only consulted when the optional
  // Locus SPA-serving above is not active.
  if (!spaServed) {
    // Try multiple paths to find the web dist directory
    const possibleWebPaths = [
      join(__dirname, 'web'),           // When running from dist/server.js
      join(__dirname, '../web'),        // Alternative dist structure
      join(__dirname, '../../web/dist') // When running from server/dist/index.js
    ];

    let webDistPath: string | undefined;
    for (const path of possibleWebPaths) {
      if (existsSync(path) && existsSync(join(path, 'index.html'))) {
        webDistPath = path;
        output.info(`Found web assets at ${webDistPath}`);
        break;
      }
    }

    if (webDistPath) {
      // Serve static files first
      app.use(express.static(webDistPath));

      // SPA fallback for client-side routing (e.g. capability URLs like
      // /cap/capId_xyz). Express 5 / path-to-regexp v8 rejects a bare '*' path,
      // so use a terminal middleware for unmatched GETs instead.
      const webRoot = webDistPath;
      app.use((req, res, next) => {
        if (req.method !== 'GET') return next();
        res.sendFile(join(webRoot, 'index.html'));
      });
    } else {
      output.warn('Web assets not found');
    }
  }
  
  // Cap control-plane message size. Payloads are JSON envelopes wrapping a
  // base64 frame (~1.33x the raw frame) plus routing metadata; allow generous
  // headroom over maxFrameBytes but far below the ws 100 MiB default so a
  // single message cannot exhaust memory before it is parsed.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxFrameBytes * 2,
  });
  
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url!, `http://${request.headers.host}`);
    // Determine client IP. Only trust X-Forwarded-For when explicitly behind a
    // proxy we control (TRUST_PROXY); otherwise it is attacker-spoofable and
    // would let clients evade rate limits / grow the bucket map unbounded.
    const xff = (request.headers['x-forwarded-for'] as string) || '';
    const ip = config.trustProxy
      ? (xff.split(',')[0]?.trim() || request.socket.remoteAddress || 'unknown')
      : (request.socket.remoteAddress || 'unknown');

    // Per-IP token bucket with backoff for all WS upgrades
    const decision = wsRateLimiter.check(ip);
    if (!decision.allowed) {
      const retrySec = decision.retryAfterMs ? Math.ceil(decision.retryAfterMs / 1000) : 1;
      try {
        socket.write(
          'HTTP/1.1 429 Too Many Requests\r\n' +
          'Connection: close\r\n' +
          `Retry-After: ${retrySec}\r\n` +
          '\r\n'
        );
      } catch {}
      socket.destroy();
      return;
    }
    
    if (url.pathname === '/agent/register') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        setupAgentRoute(ws, routing);
      });
    } else if (url.pathname.startsWith('/relay/')) {
      const parts = url.pathname.split('/');
      if (parts.length === 3 && parts[2]) {
        const capId = parts[2];
        
        wss.handleUpgrade(request, socket, head, (ws) => {
          setupRelayRoute(ws, routing, capId);
        });
      } else {
        socket.destroy();
      }
    } else {
      socket.destroy();
    }
  });
  
  await new Promise<void>((resolveListen) => {
    server.listen(config.port, config.host, () => {
      output.info(`Server started on ${config.host}:${config.port}`);
      resolveListen();
    });
  });

  process.on('SIGINT', () => {
    output.info('Shutting down');
    server.close();
    process.exit(0);
  });

  // Return the http server so callers/tests can inspect the bound address and
  // shut it down cleanly. The CLI entry point ignores the return value.
  return server;
}

if (isMainModule()) {
  const program = new Command();

  program
    .name('entangle-relay')
    .description('Entangle blind relay server')
    .version(getVersionInfo())
    .option('--output-mode <mode>', 'Output mode: text or stream-json', 'text');

  program
    .command('start')
    .description('Start the relay server')
    .action(async () => {
      try {
        await startServer(program.opts().outputMode);
      } catch (error) {
        const outputMode = parseOutputMode(program.opts().outputMode);
        const output = new OutputHandler({ mode: outputMode });
        output.error('Failed to start server', error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Default action when no command is specified
  if (process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === '--output-mode')) {
    program.outputHelp();
  } else {
    program.parse();
  }
}
