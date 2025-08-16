#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { createLogger, getConfig, getVersionInfo, OutputHandler, parseOutputMode } from '@sunpix/entangle-utils';
import { setupAgentRoute } from './routes/agent.js';
import { setupRelayRoute } from './routes/relay.js';
import { RoutingState } from './state/routing.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function startServer(outputMode: string = 'text'): Promise<void> {
  // Ensure all loggers in this process share the same output mode
  process.env.OUTPUT_MODE = outputMode;
  const logger = createLogger('server', outputMode);
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
      logger.info({ webDistPath }, 'Found web assets');
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
    logger.warn('Web assets not found');
  }
  
  const wss = new WebSocketServer({ noServer: true });
  
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url!, `http://${request.headers.host}`);
    
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
    logger.info({ port: config.port, host: config.host }, 'Server started');
  });
  
  process.on('SIGINT', () => {
    logger.info('Shutting down');
    server.close();
    process.exit(0);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let outputMode = 'text';
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output-mode' && i + 1 < args.length) {
      outputMode = args[i + 1] || 'text';
      i++;
    }
  }
  
  startServer(outputMode).catch((error) => {
    const output = new OutputHandler({ mode: parseOutputMode(outputMode) });
    output.error('Failed to start server', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
