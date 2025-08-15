import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/test-setup.ts'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules', 'dist', '*.config.ts', 'tests'],
    },
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      '@sunpix/entangle-protocol': resolve(__dirname, './packages/protocol/src'),
      '@sunpix/entangle-crypto': resolve(__dirname, './packages/crypto/src'),
      '@sunpix/entangle-utils': resolve(__dirname, './packages/utils/src'),
    },
  },
});