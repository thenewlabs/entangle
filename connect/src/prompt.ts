/**
 * Read a secret from the terminal without echoing it.
 *
 * Used when an agent requires a password but none was supplied on the command
 * line. We deliberately do NOT accept the password from the capability URL — a
 * second factor that travels with `S` is no second factor — so the only ways in
 * are the `--password` flag or this interactive prompt.
 *
 * Requires an interactive TTY; in a non-interactive context (pipe, CI) there is
 * nothing to prompt, so we fail with guidance to use `--password` instead.
 */
export function promptHidden(query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;

    if (!stdin.isTTY) {
      reject(new Error('Password required but no interactive terminal is available; pass --password'));
      return;
    }

    stdout.write(query);

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    let input = '';
    const finish = (cb: () => void) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write('\n');
      cb();
    };

    const onData = (data: Buffer) => {
      for (const ch of data.toString('utf8')) {
        const code = ch.charCodeAt(0);
        if (code === 0x0a || code === 0x0d) {
          // Enter (LF / CR)
          finish(() => resolve(input));
          return;
        } else if (code === 0x03) {
          // Ctrl-C
          finish(() => reject(new Error('Password entry cancelled')));
          return;
        } else if (code === 0x7f || code === 0x08) {
          // DEL / Backspace
          input = input.slice(0, -1);
        } else if (code >= 0x20) {
          // Printable; ignore other control characters.
          input += ch;
        }
      }
    };

    stdin.on('data', onData);
  });
}
