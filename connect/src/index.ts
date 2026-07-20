#!/usr/bin/env node

import { Command } from 'commander';
import { getVersionInfo, OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';
import { openTerminal } from './terminal.js';
import { runSingle } from './single.js';

function parseCapUrl(u: string): { host: string; capId: string; S: string } {
  const url = new URL(u);
  const parts = url.pathname.split('/');
  const capId = parts[parts.length - 1];

  if (!capId || capId === '') {
    throw new Error('Invalid capability URL: missing capId');
  }

  // Extract S from the fragment. A password is intentionally NOT read from the
  // URL — supply it via --password or the interactive prompt so the second
  // factor never travels alongside S.
  const hashParams = new URLSearchParams(url.hash.slice(1));
  const s = hashParams.get('S');

  if (!s) {
    throw new Error('Invalid capability URL: missing S in fragment');
  }

  return { host: url.host, capId, S: s };
}

const program = new Command();

program
  .name('entangle-connect')
  // Everything after <cap-url> is the remote command verbatim, so flags like
  // `ls -la` or `sh -c '...'` are passed through instead of being parsed as
  // entangle-connect options. entangle-connect's own options go before the URL
  // (e.g. `entangle-connect --cwd /srv <url> ls -la`); `--` also works.
  .enablePositionalOptions()
  .passThroughOptions()
  .description(
    'Run a command or open a terminal on a capability URL.\n' +
      'The secret in the #S= fragment never leaves this process: it authenticates you\n' +
      'to the agent directly, and the relay in between stays blind.',
  )
  .version(getVersionInfo(import.meta.url))
  .argument('<cap-url>', 'Capability URL, as https://relay/cap/<capId>#S=<secret>. Quote it so the shell keeps the fragment')
  .argument('[command...]', 'Command and arguments to run. Omit it to open an interactive terminal')
  .option('--cwd <path>', 'Working directory on the agent (must sit inside the agent\'s boundary)')
  .option('--cols <n>', 'Terminal columns', '80')
  .option('--rows <n>', 'Terminal rows', '24')
  .option('--abort-after-ms <n>', 'Abort the command after N milliseconds (default: the agent\'s own wall-clock limit)')
  .option('--output-mode <mode>', 'Output mode: text or stream-json', 'text')
  .option('--password <password>', 'Password, when the agent was started with one')
  .action(async (capUrl: string, commandArgs: string[], options) => {
    try {
      // Propagate output mode to all modules in this process
      process.env.OUTPUT_MODE = options.outputMode;
      const outputMode = parseOutputMode(options.outputMode);
      const output = new OutputHandler({ mode: outputMode });
      
      const { host, capId, S } = parseCapUrl(capUrl);
      const password = options.password;
      const protocol = capUrl.startsWith('https://') ? 'wss' : 'ws';
      const wsUrl = `${protocol}://${host}/relay/${capId}`;
      
      const cols = parseInt(options.cols, 10);
      const rows = parseInt(options.rows, 10);
      
      if (commandArgs.length === 0) {
        // Terminal mode
        output.version('Entangle Invoke - Terminal Mode', getVersionInfo(import.meta.url));
        
        const terminalOptions: { cwd?: string; cols?: number; rows?: number } = { cols, rows };
        if (options.cwd !== undefined) terminalOptions.cwd = options.cwd;
        
        await openTerminal(wsUrl, S, terminalOptions, password);
      } else {
        // Single command mode
        output.version('Entangle Invoke - Command Mode', getVersionInfo(import.meta.url));
        
        const singleOptions: { argv: string[]; cwd?: string; abortAfterMs?: number } = { argv: commandArgs };
        if (options.cwd !== undefined) singleOptions.cwd = options.cwd;
        if (options.abortAfterMs !== undefined) singleOptions.abortAfterMs = parseInt(options.abortAfterMs, 10);
        
        await runSingle(wsUrl, S, singleOptions, password);
      }
      
    } catch (error) {
      const outputMode = parseOutputMode(options.outputMode);
      const output = new OutputHandler({ mode: outputMode });
      output.error('Failed', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Add examples to help text
program.addHelpText('after', `
Argument order matters. Everything after the capability URL belongs to the remote
command, so put entangle-connect's own options before the URL. That is what lets
"ls -la" or "sh -c '...'" reach the agent untouched. A bare -- works too.

Quote the URL. An unquoted #S= fragment is a comment to most shells, and the
secret would be dropped before entangle-connect ever sees it.

Examples:
  # Interactive terminal
  entangle-connect 'https://relay.example.com/cap/capId#S=secret'

  # Single command
  entangle-connect 'https://relay.example.com/cap/capId#S=secret' ls -la

  # Options go before the URL, the command after it
  entangle-connect --cwd /srv/app 'https://relay.example.com/cap/capId#S=secret' ls -la

  # Terminal with a custom size
  entangle-connect --cols 120 --rows 40 'https://relay.example.com/cap/capId#S=secret'

  # Give up on a slow command after 5 seconds
  entangle-connect --abort-after-ms 5000 'https://relay.example.com/cap/capId#S=secret' make build

  # Machine-readable output for scripts
  entangle-connect --output-mode stream-json 'https://relay.example.com/cap/capId#S=secret' pwd`);

program.parse();