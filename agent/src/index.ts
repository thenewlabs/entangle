#!/usr/bin/env node

import { Command } from 'commander';
import { createLogger, getConfig } from '@sunpix/entangle-utils';
import { startAgent } from './agent.js';
import { createCapability } from './capability.js';

const logger = createLogger('agent-cli');
const program = new Command();

program
  .name('entangle-agent')
  .description('Entangle secure agent for exposing CLI tools')
  .version('1.0.0');

program
  .command('start')
  .description('Start the agent and register with server')
  .option('--server <url>', 'Server URL')
  .action(async (options) => {
    try {
      const config = getConfig();
      const serverUrl = options.server || config.relayUrl || 'http://localhost:8080';
      
      await startAgent({
        serverUrl,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to start agent');
      process.exit(1);
    }
  });

program
  .command('create-cap')
  .description('Create a new capability')
  .option('--single-run', 'Allow only one run per session (default: multiple runs allowed)')
  .action(async (options) => {
    try {
      const cap = await createCapability({
        singleRun: options.singleRun,
      });
      
      console.log('\nCapability created:');
      console.log(`capId: ${cap.capId}`);
      console.log(`S: ${cap.S}`);
      
      const config = getConfig();
      const relayUrl = config.relayUrl || config.publicOrigin || 'https://suncoder.dev';
      const link = `${relayUrl}/cap/${cap.capId}#S=${cap.S}`;
      console.log(`\nWeb URL: ${link}`);
    } catch (error) {
      logger.error({ error }, 'Failed to create capability');
      process.exit(1);
    }
  });

program.parse();