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
  .option('--tool <path...>', 'Path(s) to the tool(s) to expose (can specify multiple)')
  .option('--server <url>', 'Server URL')
  .option('--policy-file <path>', 'Path to policy JSON file')
  .action(async (options) => {
    try {
      const config = getConfig();
      const serverUrl = options.server || config.relayUrl || 'http://localhost:8080';
      
      // Handle multiple tools
      let tools: string[] = [];
      if (options.tool && options.tool.length > 0) {
        tools = options.tool;
      } else if (config.agentTool) {
        tools = [config.agentTool];
      } else {
        logger.error('No tool specified. Use --tool or set AGENT_TOOL');
        process.exit(1);
      }
      
      await startAgent({
        tools,
        serverUrl,
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
  .option('--tool <path>', 'Path to the tool for this capability')
  .option('--single-run', 'Allow only one run per session (default: multiple runs allowed)')
  .action(async (options) => {
    try {
      const config = getConfig();
      const toolPath = options.tool || config.agentTool;
      
      if (!toolPath) {
        logger.error('No tool specified. Use --tool or set AGENT_TOOL');
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
      
      console.log('\nCapability created:');
      console.log(`namespace: ${cap.namespace}`);
      console.log(`capId: ${cap.capId}`);
      console.log(`S: ${cap.S}`);
      console.log(`tool: ${cap.tool}`);
      console.log(`policy: singleRun=${cap.policy.singleRun}`);
      
      const config2 = getConfig();
      const relayUrl = config2.relayUrl || config2.publicOrigin || 'http://localhost:8080';
      const link = `${relayUrl}/${cap.namespace}/${cap.capId}#S=${cap.S}`;
      console.log(`\nWeb link: ${link}`);
      
      // Extract tool name from path
      const toolName = toolPath.split('/').pop() || 'tool';
      console.log(`\nInvoke command example:`);
      console.log(`entangle-invoke "${link}" ${toolName} --help`);
    } catch (error) {
      logger.error({ error }, 'Failed to create capability');
      process.exit(1);
    }
  });

program.parse();