#!/usr/bin/env node

import { Command } from 'commander';
import { getConfig, getVersionInfo, OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';
import { startAgent } from './agent.js';
import { createCapability, parseCapabilityUrl } from './capability.js';

const program = new Command();

program
  .name('entangle-serve')
  .description('Entangle secure agent for exposing CLI tools')
  .version(getVersionInfo())
  .option('--output-mode <mode>', 'Output mode: text or stream-json', 'text');

program
  .command('start')
  .description('Start the agent and register with server')
  .option('--server <url>', 'Server URL')
  .option('--password <password>', 'Optional password for agent authentication')
  .option('--capability <url>', 'Serve a specific capability URL (https://relay/cap/<capId>#S=<secret>) instead of minting a fresh ephemeral one; its host is also used as the relay server')
  .action(async (options) => {
    try {
      // Propagate output mode to all loggers in this process
      process.env.OUTPUT_MODE = program.opts().outputMode;
      const outputMode = parseOutputMode(program.opts().outputMode);
      const output = new OutputHandler({ mode: outputMode });

      output.version('Entangle Agent', getVersionInfo());

      const config = getConfig();
      const capUrl = options.capability || process.env.ENTANGLE_CAPABILITY;
      const pinned = capUrl ? await parseCapabilityUrl(capUrl) : undefined;
      // Explicit --server wins, else the capability URL's origin, else config/default.
      const serverUrl = options.server || (pinned && pinned.relayOrigin) || config.relayUrl || 'http://localhost:8080';

      await startAgent({
        serverUrl,
        outputMode: program.opts().outputMode,
        password: options.password || process.env.AGENT_PASSWORD,
        ...(pinned && { pinnedCapability: pinned }),
      });
    } catch (error) {
      const outputMode = parseOutputMode(program.opts().outputMode);
      const output = new OutputHandler({ mode: outputMode });
      
      output.error('Failed to start agent', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command('create-cap')
  .description('Create a new capability')
  .option('--single-run', 'Allow only one run per session (default: multiple runs allowed)')
  .action(async (options) => {
    try {
      process.env.OUTPUT_MODE = program.opts().outputMode;
      const outputMode = parseOutputMode(program.opts().outputMode);
      const output = new OutputHandler({ mode: outputMode });
      
      const cap = await createCapability({
        singleRun: options.singleRun,
        outputMode: program.opts().outputMode,
      });
      
      output.info('\nCapability created:');
      output.info(`capId: ${cap.capId}`);
      output.info(`S: ${cap.S}`);
      
      const config = getConfig();
      const relayUrl = config.relayUrl || config.publicOrigin || 'https://suncoder.dev';
      const link = `${relayUrl}/cap/${cap.capId}#S=${cap.S}`;
      output.info(`\nWeb URL: ${link}`);
    } catch (error) {
      const outputMode = parseOutputMode(program.opts().outputMode);
      const output = new OutputHandler({ mode: outputMode });
      
      output.error('Failed to create capability', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.parse();
