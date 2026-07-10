import { OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';
import { InvokeConnection } from './connection.js';

const output = new OutputHandler({ mode: parseOutputMode(process.env.OUTPUT_MODE || 'text') });

export async function runSingle(
  wsUrl: string,
  S: string,
  options: { argv: string[]; cwd?: string | undefined; abortAfterMs?: number | undefined },
  password?: string
): Promise<void> {
  const { argv, cwd, abortAfterMs } = options;

  if (!argv || argv.length === 0) {
    throw new Error('No command provided');
  }

  const capId = wsUrl.split('/').pop()!;
  const conn = new InvokeConnection(capId, S, password);

  await conn.connect(wsUrl);
  output.info('Authenticated');

  await new Promise<void>((_resolve, reject) => {
    let exitCode = 0;
    let abortTimer: NodeJS.Timeout | undefined;

    const handle = conn.openCmd(argv, cwd ? { cwd } : {}, {
      onOpened: () => {
        if (abortAfterMs) {
          abortTimer = setTimeout(() => {
            output.info('Aborting command due to timeout');
            handle.signal('SIGTERM');
          }, abortAfterMs);
        }
      },
      onData: (chunk, channel) => {
        (channel === 'stderr' ? process.stderr : process.stdout).write(Buffer.from(chunk));
      },
      onExit: (code, signal) => {
        exitCode = code ?? 1;
        output.info(`Command exited: code=${code}, signal=${signal}`);
        if (abortTimer) clearTimeout(abortTimer);
        conn.disconnect();
        process.exit(exitCode);
      },
      onError: (message) => {
        output.error('Stream error', message);
        if (abortTimer) clearTimeout(abortTimer);
        conn.disconnect();
        reject(new Error(message));
      },
    });

    conn.onClose(() => {
      if (abortTimer) clearTimeout(abortTimer);
      process.exit(exitCode);
    });

    process.on('SIGINT', () => {
      handle.signal('SIGINT');
      conn.disconnect();
      process.exit(130);
    });
  });
}
