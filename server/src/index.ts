#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { createLogger, getConfig } from '@sunpix/entangle-utils';
import { setupAgentRoute } from './routes/agent.js';
import { setupRelayRoute } from './routes/relay.js';
import { RoutingState } from './state/routing.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = createLogger('server');

export async function startServer(): Promise<void> {
  const config = getConfig();
  const app = express();
  const server = createServer(app);
  
  const routing = new RoutingState();
  
  app.use(cors());
  app.use(express.json());
  
  app.get('/__health', (req, res) => {
    res.json({ status: 'ok', namespaces: routing.getNamespaceCount() });
  });
  
  const webDistPath = join(__dirname, '../../web/dist');
  if (existsSync(webDistPath)) {
    app.use(express.static(webDistPath));
    app.get('*', (req, res) => {
      res.sendFile(join(webDistPath, 'index.html'));
    });
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
      if (parts.length === 4) {
        const namespace = parts[2];
        const capId = parts[3];
        
        wss.handleUpgrade(request, socket, head, (ws) => {
          setupRelayRoute(ws, routing, namespace, capId);
        });
      } else {
        socket.destroy();
      }
    } else {
      socket.destroy();
    }
  });
  
  server.listen(config.port, () => {
    logger.info({ port: config.port }, 'Server started');
  });
  
  process.on('SIGINT', () => {
    logger.info('Shutting down');
    server.close();
    process.exit(0);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  });
}