#!/usr/bin/env node

/**
 * Unified Entangle CLI.
 *
 * A single `entangle` command that dispatches to the three underlying tools:
 *
 *   entangle serve   [...]  -> @thenewlabs/entangle-serve   (expose CLI tools)
 *   entangle relay   [...]  -> @thenewlabs/entangle-relay   (blind relay server)
 *   entangle connect [...]  -> @thenewlabs/entangle-connect (invoke remote caps)
 *
 * Everything after the sub-command is forwarded to the target tool verbatim, so
 * each tool keeps its exact argument parsing. This matters most for `connect`,
 * which uses passthrough options — `entangle connect <url> ls -la` must reach it
 * untouched. We spawn the tool's own entry rather than importing it so there is
 * a single, well-understood argv path.
 */

import { spawn } from 'child_process';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);

/** Each sub-command maps to the package that implements it. */
const SUBCOMMANDS: Record<string, { packages: string[]; summary: string }> = {
  serve: {
    packages: ['@thenewlabs/entangle-serve'],
    summary: 'Expose local CLI tools through a capability',
  },
  relay: {
    packages: ['@thenewlabs/entangle-relay'],
    summary: 'Run the blind relay server',
  },
  connect: {
    packages: ['@thenewlabs/entangle-connect'],
    summary: 'Invoke commands or terminal sessions on a remote capability',
  },
};

function getVersion(): string {
  const pkgUrl = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8'));
  return pkg.version as string;
}

function printUsage(): void {
  const lines = [
    'Entangle — secure blind relay for exposing CLI tools',
    '',
    'Usage: entangle <command> [options]',
    '',
    'Commands:',
    ...Object.entries(SUBCOMMANDS).map(
      ([name, { summary }]) => `  ${name.padEnd(9)}${summary}`,
    ),
    '',
    'Run "entangle <command> --help" for command-specific options.',
    '',
    'Options:',
    '  -v, --version  Print the entangle CLI version',
    '  -h, --help     Show this help',
  ];
  console.log(lines.join('\n'));
}

/** Resolve the first installed candidate package's entry point, or null. */
function resolveEntry(packages: string[]): string | null {
  for (const name of packages) {
    try {
      return require.resolve(name);
    } catch {
      // Not installed under this name — try the next alias.
    }
  }
  return null;
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '-h' || command === '--help') {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  if (command === '-v' || command === '--version') {
    console.log(getVersion());
    process.exit(0);
  }

  const target = SUBCOMMANDS[command];
  if (!target) {
    console.error(`entangle: unknown command '${command}'\n`);
    printUsage();
    process.exit(1);
  }

  const entry = resolveEntry(target.packages);
  if (!entry) {
    console.error(
      `entangle: '${command}' is unavailable — could not find ${target.packages[0]}.\n` +
        `Reinstall with "npm install -g @thenewlabs/entangle" to pull in the required tool.`,
    );
    process.exit(1);
  }

  const child = spawn(process.execPath, [entry, ...rest], { stdio: 'inherit' });

  child.on('error', (err) => {
    console.error(`entangle: failed to start '${command}': ${err.message}`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      // Re-raise the terminating signal so the parent exits the same way.
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
}

main();
