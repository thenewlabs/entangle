#!/usr/bin/env node

import { runCommand } from './run.js';
import { createLogger } from '@sunpix/entangle-utils';

const logger = createLogger('invoke');

function parseUrl(urlStr: string): { serverUrl: string; namespace: string; capId: string; S: string } {
  try {
    const url = new URL(urlStr);
    const pathParts = url.pathname.split('/').filter(Boolean);
    
    if (pathParts.length !== 2) {
      throw new Error('Invalid URL format. Expected: https://server/namespace/capId#S=secret');
    }
    
    const namespace = pathParts[0]!;
    const capId = pathParts[1]!;
    const hashPart = url.hash.slice(1);
    
    if (!hashPart || !hashPart.startsWith('S=')) {
      throw new Error('Missing secret in URL hash. Expected: #S=secret');
    }
    
    const S = hashPart.slice(2);
    
    const serverUrl = `${url.protocol}//${url.host}`;
    
    return { serverUrl, namespace, capId, S };
  } catch (error) {
    logger.error('Invalid URL format. Expected: https://server/namespace/capId#S=secret');
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.error('Usage: entangle-invoke <URL> <TOOL> [ARGS...]');
    console.error('Example: entangle-invoke "https://suncoder.dev/ns_ABC123/capId#S=secret" claude --help');
    process.exit(1);
  }
  
  const [urlStr, tool, ...toolArgs] = args;
  
  if (!urlStr || !tool) {
    console.error('Missing required arguments');
    process.exit(1);
  }
  
  try {
    const { serverUrl, namespace, capId, S } = parseUrl(urlStr);
    
    const exitCode = await runCommand({
      namespace,
      capId,
      S,
      tool,
      argv: toolArgs,
      cwd: undefined,
      serverUrl,
      abortAfterMs: undefined,
      maxOutBytes: undefined,
    });
    
    process.exit(exitCode);
  } catch (error) {
    logger.error({ error }, 'Command failed');
    process.exit(1);
  }
}

main();