import { OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';
import { InvokeConnection } from './connection.js';

const output = new OutputHandler({ mode: parseOutputMode(process.env.OUTPUT_MODE || 'text') });

export async function openTerminal(
  wsUrl: string,
  S: string,
  options: { cwd?: string | undefined; cols?: number | undefined; rows?: number | undefined },
  password?: string
): Promise<void> {
  const { cwd, cols = 80, rows = 24 } = options;

  const capId = wsUrl.split('/').pop()!;
  const conn = new InvokeConnection(capId, S, password);

  await conn.connect(wsUrl);
  output.info('Authenticated');

  await new Promise<void>((resolve) => {
    const cleanup = () => {
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch {}
      }
      process.stdin.pause();
    };

    const handle = conn.openPty({ cols, rows, ...(cwd ? { cwd } : {}) }, {
      onOpened: () => {
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', (d) => handle.write(new Uint8Array(d)));
        process.stdout.on('resize', () => {
          handle.resize(process.stdout.columns || 80, process.stdout.rows || 24);
        });
      },
      onData: (chunk) => {
        process.stdout.write(Buffer.from(chunk));
      },
      onExit: (code, signal) => {
        output.info(`Terminal exited: code=${code}, signal=${signal}`);
        cleanup();
        conn.disconnect();
        resolve();
      },
      onError: (message) => {
        output.error('Stream error', message);
        cleanup();
        conn.disconnect();
        resolve();
      },
    });

    process.on('SIGINT', () => handle.signal('SIGINT'));
    process.on('exit', cleanup);
    conn.onClose(() => { cleanup(); resolve(); });
  });
}
