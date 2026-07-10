#!/usr/bin/env node

import { Command } from 'commander';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { getConfig, getVersionInfo, OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';
import { setupAgentRoute } from './routes/agent.js';
import { setupRelayRoute } from './routes/relay.js';
import { RoutingState } from './state/routing.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, realpathSync } from 'fs';
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

export async function startServer(outputMode: string = 'text'): Promise<void> {
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

  // Security headers for the served SPA. A strict CSP limits the blast radius
  // of any injected script (the capability secret lives in JS-reachable state).
  app.use((_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "connect-src 'self' ws: wss:",
        "img-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
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
  
  const wss = new WebSocketServer({ noServer: true });
  
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
  
  server.listen(config.port, config.host, () => {
    output.info(`Server started on ${config.host}:${config.port}`);
  });
  
  process.on('SIGINT', () => {
    output.info('Shutting down');
    server.close();
    process.exit(0);
  });
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
