#!/usr/bin/env node

import { createLogger, getVersionInfo, OutputHandler, parseOutputMode } from '@sunpix/entangle-utils';
import { openTerminal } from './terminal.js';
import { runSingle } from './single.js';

function parseCapUrl(u: string): { host: string; capId: string; S: string } {
  const url = new URL(u);
  const parts = url.pathname.split('/');
  const capId = parts[parts.length - 1];
  
  if (!capId || capId === '') {
    throw new Error('Invalid capability URL: missing capId');
  }
  
  // Extract S from fragment
  const hashParams = new URLSearchParams(url.hash.slice(1));
  const s = hashParams.get('S');
  
  if (!s) {
    throw new Error('Invalid capability URL: missing S in fragment');
  }
  
  return { 
    host: url.host, 
    capId, 
    S: s 
  };
}

async function main() {
  const args = process.argv.slice(2);
  
  // Parse output mode first
  let outputMode = 'text';
  const outputModeIndex = args.indexOf('--output-mode');
  if (outputModeIndex !== -1 && outputModeIndex + 1 < args.length) {
    outputMode = args[outputModeIndex + 1] || 'text';
    args.splice(outputModeIndex, 2);
  }
  // Propagate to child loggers
  process.env.OUTPUT_MODE = outputMode;
  
  const logger = createLogger('invoke', outputMode);
  const output = new OutputHandler({ mode: parseOutputMode(outputMode) });
  output.version('Entangle Invoke', getVersionInfo());
  
  if (args.length === 0) {
    output.error('Usage: invoke <cap-url> [command [args...]] [--cwd PATH]');
    output.error('');
    output.error('Examples:');
    output.error('  # Interactive terminal');
    output.error('  invoke https://suncoder.dev/cap/capId#S=secret');
    output.error('');
    output.error('  # Single command');
    output.error('  invoke https://suncoder.dev/cap/capId#S=secret ls -la');
    output.error('');
    output.error('Options:');
    output.error('  --cwd <path>  Working directory');
    output.error('  --cols <n>    Terminal columns (default: 80)');
    output.error('  --rows <n>    Terminal rows (default: 24)');
    output.error('  --abort-after-ms <n>  Abort command after N milliseconds');
    output.error('  --output-mode <mode>  Output mode: text or stream-json (default: text)');
    process.exit(2);
  }
  
  const capUrl = args[0];
  if (!capUrl) {
    output.error('Error: capability URL required');
    process.exit(2);
  }
  
  try {
    const { host, capId, S } = parseCapUrl(capUrl);
    const protocol = capUrl.startsWith('https://') ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${host}/relay/${capId}`;
    
    // Parse remaining args
    const remainingArgs = args.slice(1);
    let cwd: string | undefined;
    let cols = 80;
    let rows = 24;
    let abortAfterMs: number | undefined;
    
    // Extract flags
    const commandArgs: string[] = [];
    for (let i = 0; i < remainingArgs.length; i++) {
      const arg = remainingArgs[i];
      if (!arg) continue;
      
      if (arg === '--cwd' && i + 1 < remainingArgs.length) {
        cwd = remainingArgs[++i];
      } else if (arg === '--cols' && i + 1 < remainingArgs.length) {
        cols = parseInt(remainingArgs[++i]!, 10);
      } else if (arg === '--rows' && i + 1 < remainingArgs.length) {
        rows = parseInt(remainingArgs[++i]!, 10);
      } else if (arg === '--abort-after-ms' && i + 1 < remainingArgs.length) {
        abortAfterMs = parseInt(remainingArgs[++i]!, 10);
      } else {
        commandArgs.push(arg);
      }
    }
    
    if (commandArgs.length === 0) {
      // Terminal mode
      const terminalOptions: { cwd?: string; cols?: number; rows?: number } = { cols, rows };
      if (cwd !== undefined) terminalOptions.cwd = cwd;
      await openTerminal(wsUrl, S, terminalOptions);
    } else {
      // Single command mode
      const singleOptions: { argv: string[]; cwd?: string; abortAfterMs?: number } = { argv: commandArgs };
      if (cwd !== undefined) singleOptions.cwd = cwd;
      if (abortAfterMs !== undefined) singleOptions.abortAfterMs = abortAfterMs;
      await runSingle(wsUrl, S, singleOptions);
    }
    
  } catch (error) {
    output.error('Failed', error instanceof Error ? error.message : String(error));
    logger.error({ error }, 'Failed');
    process.exit(1);
  }
}

main().catch(e => { 
  console.error(e); 
  process.exit(1); 
});
