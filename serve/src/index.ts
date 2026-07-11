#!/usr/bin/env node

import { Command } from 'commander';
import { getConfig, getVersionInfo, OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';
import { startAgent } from './agent.js';
import { createCapability, resolveServeTarget } from './capability.js';
import { promptHidden } from './prompt.js';
import { SharedWorkspace } from './shared-workspace.js';
import { attachHostTerminal, type HostTerminalHandle } from './host-terminal.js';

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
  .option('--password [password]', 'Require a password to connect; pass the flag alone to be prompted, or set AGENT_PASSWORD')
  .option('--capability <url>', 'Serve a specific capability URL (https://relay/cap/<capId>#S=<secret>) instead of minting a fresh ephemeral one; its host is also used as the relay server')
  .option('--shared', 'Serve one shared terminal that everyone with the URL attaches to (default when run in a terminal)')
  .option('--headless', 'Run headless: each connection gets its own shell instead of a shared terminal')
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

      // `--password` with no value (commander yields `true`) prompts interactively
      // so the secret never appears in argv; a string value or AGENT_PASSWORD is
      // used verbatim.
      let password: string | undefined;
      if (options.password === true) {
        password = await promptHidden('Agent password: ');
      } else if (typeof options.password === 'string') {
        password = options.password;
      } else {
        password = process.env.AGENT_PASSWORD;
      }

      // Shared-terminal mode: on by default when attached to a real terminal,
      // forced by --shared, disabled by --headless/--no-shared. Only meaningful
      // in text mode (stream-json is for programmatic invokers).
      const isTty = !!process.stdout.isTTY && !!process.stdin.isTTY;
      const shared =
        options.headless === true ? false
        : options.shared === true ? true
        : isTty && outputMode === 'text';

      let sharedWorkspace: SharedWorkspace | undefined;
      // The host UI (when attached) sizes the active window to the box interior
      // and takes the session URL for its bottom bar once the relay assigns it.
      let hostHandle: HostTerminalHandle | undefined;
      if (shared) {
        const cols = process.stdout.columns || 80;
        const rows = process.stdout.rows || 24;
        sharedWorkspace = new SharedWorkspace(output, { cols, rows });
        if (isTty) hostHandle = attachHostTerminal(sharedWorkspace, output);
      }

      await startAgent({
        serverUrl,
        outputMode: program.opts().outputMode,
        ...(password ? { password } : {}),
        ...(pinnedCapability && { pinnedCapability }),
        ...(sharedWorkspace && {
          sharedWorkspace,
          onCapabilityReady: ({ link }) => {
            if (hostHandle) hostHandle.setUrl(link);
            else output.info(`⧉ entangle session shared — open to collaborate:\n  ${link}\n`);
          },
        }),
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
