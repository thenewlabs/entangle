#!/usr/bin/env node

import { Command } from 'commander';
import { runCommand } from './run.js';
import { createLogger } from '@sunpix/entangle-utils';

const logger = createLogger('invoke');

const program = new Command();

program
  .name('entangle-invoke')
  .description('Invoke remote CLI tools via Entangle')
  .version('1.0.0')
  .requiredOption('--namespace <ns>', 'Namespace from agent')
  .requiredOption('--cap-id <id>', 'Capability ID')
  .requiredOption('--secret-s <secret>', 'Secret key S')
  .requiredOption('--tool <tool>', 'Tool to run')
  .requiredOption('--argv <json>', 'Arguments as JSON array')
  .option('--cwd <path>', 'Working directory')
  .option('--server <url>', 'Server URL', 'http://localhost:8080')
  .option('--abort-after-ms <ms>', 'Abort after milliseconds')
  .option('--max-out-bytes <bytes>', 'Maximum output bytes')
  .action(async (options) => {
    try {
      let argv: string[];
      try {
        argv = JSON.parse(options.argv);
        if (!Array.isArray(argv)) {
          throw new Error('argv must be an array');
        }
      } catch (error) {
        logger.error('Invalid argv JSON');
        process.exit(1);
      }
      
      const exitCode = await runCommand({
        namespace: options.namespace,
        capId: options.capId,
        S: options.secretS,
        tool: options.tool,
        argv,
        cwd: options.cwd,
        serverUrl: options.server,
        abortAfterMs: options.abortAfterMs ? parseInt(options.abortAfterMs) : undefined,
        maxOutBytes: options.maxOutBytes ? parseInt(options.maxOutBytes) : undefined,
      });
      
      process.exit(exitCode);
    } catch (error) {
      logger.error({ error }, 'Command failed');
      process.exit(1);
    }
  });

program.parse();