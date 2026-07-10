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
console.log('Note: Development versions (.js) work correctly. Minified versions (.min.js) may have import.meta.url issues.');

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

console.log('✓ All standalone executables built successfully!');
console.log(`\nFiles created in ${distDir}:`);
console.log('- serve.js (+ serve.min.js) - Fully bundled serve executable');
console.log('- connect.js (+ connect.min.js) - Fully bundled connect CLI');
console.log('- relay.js (+ relay.min.js) - Fully bundled relay server with web assets');
console.log('- web/ (static assets for server)');

async function buildFullyBundledExecutable({ name, entryPoint, outfile }) {
  try {
    // Build development version - fully bundled
    await build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: outfile + '.cjs.temp',
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
      external: [
        'fsevents',
        '@homebridge/node-pty-prebuilt-multiarch',
      ],
      minify: true,
      keepNames: true,
    });

    // Create final executables, check if shebang already exists
    const shebang = '#!/usr/bin/env node\n';
    
    let devContent = readFileSync(outfile + '.cjs.temp', 'utf8');
    // Replace import.meta.url with a CommonJS-compatible equivalent
    devContent = devContent.replace(/import\.meta\.url/g, '(__filename ? "file://" + __filename : undefined)');
    devContent = devContent.replace(/import_meta\d*\.url/g, '(__filename ? "file://" + __filename : undefined)');
    
    if (devContent.startsWith('#!/usr/bin/env node')) {
      writeFileSync(outfile, devContent);
    } else {
      writeFileSync(outfile, shebang + devContent);
    }
    
    let minContent = readFileSync(minOutfile + '.cjs.temp', 'utf8');
    // Replace import.meta.url with a CommonJS-compatible equivalent
    minContent = minContent.replace(/import\.meta\.url/g, '(__filename ? "file://" + __filename : undefined)');
    minContent = minContent.replace(/import_meta\d*\.url/g, '(__filename ? "file://" + __filename : undefined)');
    
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