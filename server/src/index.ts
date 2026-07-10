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
import { existsSync } from 'fs';
import { wsRateLimiter } from './utils/rate-limit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function startServer(outputMode: string = 'text'): Promise<void> {
  // Ensure all loggers in this process share the same output mode
  process.env.OUTPUT_MODE = outputMode;
  const output = new OutputHandler({ mode: parseOutputMode(outputMode) });
  output.version('Entangle Server', getVersionInfo());
  
  const config = getConfig();
  const app = express();
  const server = createServer(app);
  
  const routing = new RoutingState();
  
  app.use(cors());
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
    
    // Catch all routes to serve the SPA for client-side routing
    // This includes capability URLs like /cap/capId_xyz
    app.get('*', (_req, res) => {
      res.sendFile(join(webDistPath, 'index.html'));
    });
  } else {
    output.warn('Web assets not found');
  }
  
  const wss = new WebSocketServer({ noServer: true });
  
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url!, `http://${request.headers.host}`);
    // Determine client IP (trust x-forwarded-for if present)
    const xff = (request.headers['x-forwarded-for'] as string) || '';
    const ip = (xff.split(',')[0]?.trim()) || (request.socket.remoteAddress || 'unknown');

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

if (import.meta.url === `file://${process.argv[1]}`) {
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
