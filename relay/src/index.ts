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
  output.version('Entangle Server', getVersionInfo(import.meta.url));
  
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

  // The Locus view frames the preview origin in an iframe. Each preview now gets
  // its OWN wildcard subdomain `<token>.preview.<domain>` (own browser origin →
  // own Service Worker / cookies / storage), so widen framing to BOTH the base
  // preview host AND any `*.preview.<domain>` subdomain. Allow both http and
  // https on any port so the same derivation works locally
  // (preview.localhost:8080, p3x9.preview.localhost:8080) and in prod
  // (preview.locus.thenewlabs.com, p3x9.preview.locus.thenewlabs.com over
  // https). Nothing else is broadened.
  const frameSources = previewHost
    ? [
        "'self'",
        `http://${previewHost}:*`,
        `https://${previewHost}:*`,
        `http://*.${previewHost}:*`,
        `https://*.${previewHost}:*`,
      ]
    : ["'self'"];

  // A request is a "preview host" request iff its Host (port-stripped,
  // lowercased) EQUALS the base preview host OR ends with `.<previewHost>`
  // (i.e. a `<token>.preview.<domain>` per-preview subdomain).
  const matchesPreviewHost = (host: string): boolean =>
    !!previewHost && (host === previewHost || host.endsWith('.' + previewHost));

  const isPreviewHostReq = (req: express.Request): boolean => {
    const host = (req.headers.host ?? '').split(':')[0]?.trim().toLowerCase() ?? '';
    return matchesPreviewHost(host);
  };

  // Framing needs BOTH sides to agree: the VIEW page's `frame-src` (above) lets
  // it embed the preview iframe, but the PREVIEW response must also permit being
  // framed via `frame-ancestors`. Compute the allowed view origin(s) that may
  // frame the preview: an explicit `RELAY_VIEW_ORIGIN` (comma-separated) if set,
  // else derive it from the request — the preview host is conventionally a
  // per-preview `<token>.preview.` subdomain (or the bare `preview.` base) of
  // the view host, so strip that FULL prefix and keep the request scheme +
  // host:port (e.g. p3x9.preview.locus.thenewlabs.com → locus.thenewlabs.com
  // over https, preview.localhost:8080 → localhost:8080).
  const viewOriginsForPreview = (req: express.Request): string[] => {
    const env = (process.env.RELAY_VIEW_ORIGIN || '').trim();
    if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
    const host = (req.headers.host ?? '').trim();
    if (!host) return [];
    const xfProto = ((req.headers['x-forwarded-proto'] as string) || '').split(',')[0]?.trim();
    const scheme = xfProto || req.protocol || 'http';
    // Strip the full `<label>.preview.` OR bare `preview.` prefix to yield the
    // view host (matched case-insensitively, anchored at the start).
    const viewHost = host.replace(/^(?:[^.]+\.)?preview\./i, '');
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

      // Any `<token>.preview.<domain>` subdomain (or the base preview host) is
      // served the preview bootstrap / preview static dir, exactly like the base
      // preview host — see matchesPreviewHost above.
      const isPreviewHost = (req: express.Request): boolean => {
        const host = (req.headers.host ?? '').split(':')[0]?.trim().toLowerCase() ?? '';
        return matchesPreviewHost(host);
      };

      // The Locus VIEW SPA expects a global `window.entangle` (openPipe /
      // openTerminal) to already exist — it is provided by entangle's browser
      // client, which parses capId from the path and the secret from the #S=
      // fragment as a module-load side effect. Inject it into the served view
      // index.html as a same-origin classic script (CSP 'self' allows it, and
      // the secret never leaves the browser) so it runs BEFORE the SPA's
      // deferred module.
      //
      // The PREVIEW origin also gets the client now: its Service-Worker tunnel
      // pumps intercepted requests over the entangle `preview` pipe, which needs
      // `window.entangle` on the preview sub-origin. The Locus panel frames the
      // preview at `/cap/<id>#S=<secret>` (same cap as the view), so the injected
      // client authenticates there too and opens its own `preview` pipe. (A second
      // connection under the same capId is fine — maxStreams is 32.)
      const entangleClientJs = await loadEntangleClient(output);
      const injectClient = (html: string): string =>
        entangleClientJs
          ? html.replace('</head>', '  <script src="/__entangle-client.js"></script>\n</head>')
          : html;
      const rawIndexHtml = readFileSync(join(viewDir, 'index.html'), 'utf8');
      const viewIndexHtml = injectClient(rawIndexHtml);
      if (!entangleClientJs) {
        output.warn(
          'Entangle client bundle unavailable (no dist/entangle-client.js and esbuild fallback failed); ' +
            'served SPA will not have window.entangle',
        );
      }

      // The preview bootstrap document, prepared once at startup: blank the
      // `__LOCUS_TRANSPORT__` placeholder (production drives the tunnel over the
      // entangle `preview` pipe, not the WebSocket double — a non-empty value would
      // force the WS path) and inject the entangle client so `window.entangle` exists.
      const previewDocPath = join(previewDir, previewDoc);
      const previewHtml = existsSync(previewDocPath)
        ? injectClient(readFileSync(previewDocPath, 'utf8').replaceAll('__LOCUS_TRANSPORT__', ''))
        : null;
      if (previewHost && !previewHtml) {
        output.warn(`Preview host set but no ${previewDoc} at ${previewDir}; preview-serving degraded`);
      }

      // Serve the entangle client bundle on BOTH host roles (same-origin classic
      // script; CSP 'self' allows it).
      app.get('/__entangle-client.js', (_req, res) => {
        if (!entangleClientJs) {
          res.status(404).end();
          return;
        }
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.send(entangleClientJs);
      });

      // The document itself (/, /index.html) must carry the injected client, so
      // intercept it BEFORE the static handler (which would otherwise serve the
      // un-injected file). The preview host serves its (blanked, injected)
      // bootstrap document; every other host serves the view SPA.
      app.get(['/', '/index.html'], (req, res, next) => {
        if (isPreviewHost(req)) {
          if (!previewHtml) return next();
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.send(previewHtml);
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(viewIndexHtml);
      });

      // `index: false` on the view static so `/` reaches the handler above
      // instead of auto-serving the un-injected index.html.
      const viewStatic = express.static(viewDir, { index: false });
      // `index: false` so `/` on the preview host does NOT auto-serve the view's
      // index.html (previewDir usually === viewDir and contains both index.html
      // and preview.html); it falls through to the SPA fallback which sends
      // preview.html — the Service-Worker preview bootstrap.
      const previewStatic = express.static(previewDir, { index: false });

      // Static assets: preview host reads from the preview dir, everyone else
      // from the view dir (usually the same directory).
      app.use((req, res, next) => {
        if (isPreviewHost(req)) return previewStatic(req, res, next);
        return viewStatic(req, res, next);
      });

      // SPA fallback for client-side routing. Express 5 / path-to-regexp v8
      // rejects a bare '*' path, so use a terminal middleware for unmatched
      // GETs. The document depends on the host role. The view catch-all (e.g.
      // /cap/<id>) returns the index with the entangle client injected; the
      // preview catch-all returns the (transport-blanked, client-injected)
      // bootstrap so hard reloads heal back onto the Service-Worker bridge —
      // including its own `/cap/<id>#S=` URL, which re-auths the entangle client.
      app.use((req, res, next) => {
        if (req.method !== 'GET') return next();
        if (isPreviewHost(req)) {
          // Real control/static files must serve as themselves (or 404), never as
          // the HTML fallback — a MIME mismatch would break the SW / bootstrap
          // module. If they reach here the file is genuinely missing.
          const p = req.path;
          if (p === '/sw.js' || p.startsWith('/__locus/') || p.startsWith('/assets/')) {
            return res.status(404).end();
          }
          if (!previewHtml) return res.sendFile(previewDocPath);
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.send(previewHtml);
        }
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
    .description(
      'The blind half of entangle. Routes encrypted frames between agents and clients,\n' +
        'and never sees the capability secret, the derived keys or a byte of plaintext.',
    )
    .version(getVersionInfo(import.meta.url))
    .option('--output-mode <mode>', 'Output mode: text or stream-json', 'text');

  program
    .command('start')
    .description('Start the relay server (configured entirely through the environment)')
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

  program.addHelpText(
    'after',
    `
The relay takes no configuration flags. Everything below is read from the
environment (or a .env file next to the install) at startup.

Network:
  PORT                        Port to listen on (default: 8080)
  HOST                        Bind address (default: 0.0.0.0)
  PUBLIC_ORIGIN               Origin used when printing capability URLs
                              (default: http://localhost:8080)
  CORS_ORIGINS                Comma-separated allow-list. Empty means
                              same-origin only (default: empty)
  TRUST_PROXY                 Set to 1 to read the client IP from
                              X-Forwarded-For. Only turn this on behind a
                              proxy you control (default: off)

Agent registration:
  RELAY_AGENT_TOKEN           Shared secret an agent must present at
                              /agent/register. Strongly recommended off-localhost
  RELAY_REQUIRE_AGENT_TOKEN   Set to 1 to refuse registration when no token is
                              configured. On automatically when NODE_ENV=production

Limits:
  MAX_FRAME_BYTES             Largest accepted frame (default: 1048576)
  RELAY_RATE_RPS              Per-IP WebSocket upgrades per second (default: 10)
  RELAY_BURST                 Per-IP upgrade burst allowance (default: 50)
  RELAY_IDLE_TIMEOUT_MS       Idle connection reap time (default: 120000)
  RELAY_MAX_AGENTS            Ceiling on registered agents (default: 10000)
  RELAY_MAX_CAPS_PER_AGENT    Ceiling on capabilities per agent (default: 256)
  LOG_LEVEL                   Log verbosity (default: info)

Serving a single-page app (optional, off unless RELAY_SPA_DIR is set):
  RELAY_SPA_DIR               Directory holding index.html. Setting it makes the
                              relay the origin that serves the app
  RELAY_PREVIEW_SPA_DIR       Static directory for preview hosts
                              (default: RELAY_SPA_DIR)
  RELAY_PREVIEW_HOST          Base preview hostname. That host and any
                              <token>.preview.<host> subdomain serve the
                              preview document instead of the app
  RELAY_PREVIEW_DOC           Preview bootstrap filename (default: preview.html)
  RELAY_VIEW_ORIGIN           Comma-separated origins allowed to frame a
                              preview. Derived from the request host if unset

Examples:
  # Local relay on the default port
  entangle-relay start

  # Behind Caddy or nginx, terminating TLS for you
  PUBLIC_ORIGIN=https://entangle.example.com TRUST_PROXY=1 \\
    RELAY_AGENT_TOKEN=$TOKEN entangle-relay start

  # Check it is alive
  curl http://localhost:8080/__health`,
  );

  // Default action when no command is specified
  if (process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === '--output-mode')) {
    program.outputHelp();
  } else {
    program.parse();
  }
}
