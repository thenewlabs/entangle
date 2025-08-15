#!/usr/bin/env node

/**
 * Fake tool for testing that echoes arguments and environment
 */

const args = process.argv.slice(2);

if (args[0] === '--echo') {
  console.log(args.slice(1).join(' '));
} else if (args[0] === '--cwd') {
  console.log(process.cwd());
} else if (args[0] === '--error') {
  console.error('Test error output');
  process.exit(1);
} else if (args[0] === '--hang') {
  // Hang forever for abort testing
  setTimeout(() => {}, 1000000);
} else if (args[0] === '--stream') {
  // Stream output over time
  let count = 0;
  const interval = setInterval(() => {
    console.log(`Line ${++count}`);
    if (count >= 5) {
      clearInterval(interval);
    }
  }, 100);
} else if (args[0] === '--signal') {
  // Exit with signal
  process.kill(process.pid, 'SIGTERM');
} else if (args[0] === '--large') {
  // Generate large output
  const chunk = 'x'.repeat(1024);
  for (let i = 0; i < 100; i++) {
    console.log(chunk);
  }
} else {
  console.log('Usage: fake-tool [--echo|--cwd|--error|--hang|--stream|--signal|--large]');
}