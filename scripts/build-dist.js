#!/usr/bin/env node

import { build } from 'esbuild';
import { execSync } from 'child_process';
import { mkdirSync, rmSync, cpSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'dist');

// Clean and create dist directory
if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true });
}
mkdirSync(distDir, { recursive: true });

console.log('Building fully bundled standalone executables...');

// Build fully bundled executables
await buildFullyBundledExecutable({
  name: 'serve',
  entryPoint: join(rootDir, 'serve/src/index.ts'),
  outfile: join(distDir, 'serve.js'),
});

await buildFullyBundledExecutable({
  name: 'connect',
  entryPoint: join(rootDir, 'connect/src/index.ts'),
  outfile: join(distDir, 'connect.js'),
});

await buildFullyBundledExecutable({
  name: 'relay',
  entryPoint: join(rootDir, 'relay/src/index.ts'),
  outfile: join(distDir, 'relay.js'),
});

// Copy web assets to dist for server
const webDistPath = join(rootDir, 'web/dist');
if (existsSync(webDistPath)) {
  const webAssetsPath = join(distDir, 'web');
  cpSync(webDistPath, webAssetsPath, { recursive: true });
  console.log('✓ Copied web assets');
}

// Bundle the entangle browser client as a classic IIFE. This is injected into
// the served SPA (RELAY_SPA_DIR mode) so `window.entangle` is attached — with
// the capability parsed from the URL — BEFORE the SPA's deferred module runs.
// Serving a prebuilt artifact keeps the relay from esbuild-ing at request time
// in production.
await buildEntangleClient();

console.log('✓ All standalone executables built successfully!');
console.log(`\nFiles created in ${distDir}:`);
console.log('- serve.js (+ serve.min.js) - Fully bundled serve executable');
console.log('- connect.js (+ connect.min.js) - Fully bundled connect CLI');
console.log('- relay.js (+ relay.min.js) - Fully bundled relay server with web assets');
console.log('- web/ (static assets for server)');

async function buildEntangleClient() {
  const webRoot = join(rootDir, 'web');
  const entryPoint = join(webRoot, 'src', 'window-entangle-spawn.ts');
  const outfile = join(distDir, 'entangle-client.js');
  if (!existsSync(entryPoint)) {
    console.warn(`⚠ Entangle client entry not found at ${entryPoint}; skipping`);
    return;
  }
  try {
    await build({
      entryPoints: [entryPoint],
      bundle: true,
      format: 'iife',
      target: 'es2020',
      absWorkingDir: webRoot,
      outfile,
    });
    console.log(`✓ Built entangle client: ${outfile} (${(readFileSync(outfile).length / 1024).toFixed(1)}KB)`);
  } catch (error) {
    console.error('✗ Failed to build entangle client:', error);
    throw error;
  }
}

async function buildFullyBundledExecutable({ name, entryPoint, outfile }) {
  // The bundle is CJS (no import.meta.url), so utils' packageVersion() cannot find the
  // package's manifest at runtime — inject the version at build time instead. The single
  // source of truth stays the workspace's own package.json.
  const pkgVersion = JSON.parse(
    readFileSync(join(dirname(dirname(entryPoint)), 'package.json'), 'utf8'),
  ).version;
  const define = {
    ENTANGLE_BUILD_VERSION: JSON.stringify(pkgVersion),
    // Rewrite every `import.meta.url` to a CJS-safe equivalent AT BUILD TIME. The old
    // post-build regex on the emitted bundle missed minifier-renamed references, so the
    // .min.js variants crashed at module load (fileURLToPath(undefined)).
    'import.meta.url': '__entangleImportMetaUrl',
  };
  const banner = {
    js: "const __entangleImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  };
  try {
    // Build development version - fully bundled
    await build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: outfile + '.cjs.temp',
      define,
      banner,
      external: [
        // Only externalize native Node.js modules that cannot be bundled
        'fsevents', // Optional native dependency
        '@homebridge/node-pty-prebuilt-multiarch', // Native bindings for PTY support
      ],
      sourcemap: true,
      keepNames: true,
      metafile: true,
    });

    // Build minified version
    const minOutfile = outfile.replace('.js', '.min.js');
    await build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: minOutfile + '.cjs.temp',
      define,
      banner,
      external: [
        'fsevents',
        '@homebridge/node-pty-prebuilt-multiarch',
      ],
      minify: true,
      keepNames: true,
    });

    // Create final executables, check if shebang already exists
    const shebang = '#!/usr/bin/env node\n';
    
    const devContent = readFileSync(outfile + '.cjs.temp', 'utf8');
    
    if (devContent.startsWith('#!/usr/bin/env node')) {
      writeFileSync(outfile, devContent);
    } else {
      writeFileSync(outfile, shebang + devContent);
    }
    
    const minContent = readFileSync(minOutfile + '.cjs.temp', 'utf8');
    
    if (minContent.startsWith('#!/usr/bin/env node')) {
      writeFileSync(minOutfile, minContent);
    } else {
      writeFileSync(minOutfile, shebang + minContent);
    }
    
    // Clean up temp files
    rmSync(outfile + '.cjs.temp');
    rmSync(minOutfile + '.cjs.temp');

    // Make executable
    execSync(`chmod +x "${outfile}"`);
    execSync(`chmod +x "${minOutfile}"`);
    
    console.log(`✓ Built ${name}: ${outfile} (${(readFileSync(outfile).length / 1024 / 1024).toFixed(1)}MB) and ${minOutfile} (${(readFileSync(minOutfile).length / 1024 / 1024).toFixed(1)}MB)`);
  } catch (error) {
    console.error(`✗ Failed to build ${name}:`, error);
    throw error;
  }
}