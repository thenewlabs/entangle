// Copies the built web SPA into the server package's dist so the published
// `entangle-relay` can serve the /cap/... UI. Runs from server's `prepack`.
// If the web build isn't present, it warns and skips (non-web builds still work).
import { existsSync, rmSync, cpSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const webDist = join(root, 'web', 'dist');
const dest = join(root, 'server', 'dist', 'web');

if (!existsSync(join(webDist, 'index.html'))) {
  console.warn(`[copy-web-to-server] web/dist not built (${webDist}); skipping. ` +
    `Run \`npm run build --workspace=@thenewlabs/entangle-web\` first for a UI-capable relay.`);
  process.exit(0);
}

rmSync(dest, { recursive: true, force: true });
cpSync(webDist, dest, { recursive: true });
console.log(`[copy-web-to-server] bundled web UI -> server/dist/web`);
