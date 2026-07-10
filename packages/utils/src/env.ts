/**
 * Build the environment for a spawned child process.
 *
 * Security: children get a MINIMAL, curated environment by default — never the
 * agent's full `process.env` (which may hold cloud credentials, tokens, etc.).
 * A caller may only set env vars whose names appear in `passthrough` (the
 * operator-controlled AGENT_ENV_PASSTHROUGH allow-list); everything else the
 * caller supplies is dropped. This also blocks caller-injected loader hooks
 * such as LD_PRELOAD / NODE_OPTIONS unless the operator explicitly allows them.
 */
export function buildChildEnv(
  passthrough: string[],
  callerEnv?: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || '/',
    USER: process.env.USER || 'nobody',
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
    TZ: process.env.TZ || 'UTC',
    TERM: process.env.TERM || 'xterm-256color',
  };

  const allow = new Set(passthrough);

  // Pass through operator-approved vars from the agent's own environment.
  for (const name of allow) {
    const val = process.env[name];
    if (val !== undefined) env[name] = val;
  }

  // Let the caller override only the approved names.
  if (callerEnv) {
    for (const [name, val] of Object.entries(callerEnv)) {
      if (allow.has(name) && typeof val === 'string') env[name] = val;
    }
  }

  return env;
}
