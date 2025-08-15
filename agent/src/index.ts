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
  .option('--tool <path>', 'Path to the tool to expose')
  .option('--server <url>', 'Server URL', 'http://localhost:8080')
  .option('--policy-file <path>', 'Path to policy JSON file')
  .action(async (options) => {
    try {
      const config = getConfig();
      const toolPath = options.tool || config.agentTool;
      
      if (!toolPath) {
        logger.error('No tool specified. Use --tool or set AGENT_TOOL');
        process.exit(1);
      }
      
      await startAgent({
        toolPath,
        serverUrl: options.server,
        policyFile: options.policyFile,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to start agent');
      process.exit(1);
    }
  });

program
  .command('create-cap')
  .description('Create a new capability')
  .option('--namespace <ns>', 'Namespace from server registration')
  .option('--single-run', 'Allow only one run per session', true)
  .action(async (options) => {
    try {
      const config = getConfig();
      const toolPath = config.agentTool;
      
      if (!toolPath) {
        logger.error('No tool configured. Set AGENT_TOOL');
        process.exit(1);
      }
      
      if (!options.namespace) {
        logger.error('Namespace required. Run agent start first');
        process.exit(1);
      }
      
      const cap = await createCapability({
        namespace: options.namespace,
        tool: toolPath,
        singleRun: options.singleRun,
      });
      
      console.log('Capability created:');
      console.log(`namespace: ${cap.namespace}`);
      console.log(`capId: ${cap.capId}`);
      console.log(`S: ${cap.S}`);
      console.log(`tool: ${cap.tool}`);
      console.log(`policy: singleRun=${cap.policy.singleRun}`);
      
      const config2 = getConfig();
      const link = `${config2.publicOrigin}/${cap.namespace}/${cap.capId}#S=${cap.S}`;
      console.log(`\nWeb link: ${link}`);
    } catch (error) {
      logger.error({ error }, 'Failed to create capability');
      process.exit(1);
    }
  });

program.parse();