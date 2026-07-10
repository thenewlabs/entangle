#!/usr/bin/env node

import { Command } from 'commander';
import { getConfig, getVersionInfo, OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';
import { startAgent } from './agent.js';
import { createCapability, resolveServeTarget } from './capability.js';

const program = new Command();

program
  .name('entangle-serve')
  .description('Entangle secure agent for exposing CLI tools')
  .version(getVersionInfo())
  .option('--output-mode <mode>', 'Output mode: text or stream-json', 'text');

program
  // Default command: `entangle serve [url]` runs the agent without needing an
  // explicit `start`. The positional URL is either a bare relay origin
  // (mint a fresh capability there) or a full capability URL (serve that exact
  // capability); flags still work and take precedence over the positional.
  .command('start', { isDefault: true })
  .description('Start the agent (mint a fresh capability or serve a pinned one) and register with the relay')
  .argument('[url]', 'Relay origin (https://relay) to mint a fresh capability on, or a full capability URL (https://relay/cap/<capId>#S=<secret>) to serve that exact capability')
  .option('--server <url>', 'Relay server URL (overrides the origin of the positional URL)')
  .option('--password <password>', 'Optional password for agent authentication')
  .option('--capability <url>', 'Serve a specific capability URL (https://relay/cap/<capId>#S=<secret>) instead of minting a fresh ephemeral one; its host is also used as the relay server')
  .action(async (url: string | undefined, options) => {
    try {
      // Propagate output mode to all loggers in this process
      process.env.OUTPUT_MODE = program.opts().outputMode;
      const outputMode = parseOutputMode(program.opts().outputMode);
      const output = new OutputHandler({ mode: outputMode });

      output.version('Entangle Agent', getVersionInfo());

      const config = getConfig();
      const { serverUrl, pinnedCapability } = await resolveServeTarget({
        positionalUrl: url,
        capabilityFlag: options.capability,
        serverFlag: options.server,
        envCapability: process.env.ENTANGLE_CAPABILITY,
        configRelayUrl: config.relayUrl,
      });

      await startAgent({
        serverUrl,
        outputMode: program.opts().outputMode,
        password: options.password || process.env.AGENT_PASSWORD,
        ...(pinnedCapability && { pinnedCapability }),
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

program.addHelpText('after', `
Examples:
  # Mint a fresh capability and serve it on a relay
  entangle serve https://entangle.thenewlabs.com

  # Serve a specific capability (its origin is used as the relay)
  entangle serve https://entangle.thenewlabs.com/cap/<capId>#S=<secret>

  # Mint on the configured/default relay
  entangle serve

  # Just create a capability without starting the agent
  entangle serve create-cap`);

program.parse();
