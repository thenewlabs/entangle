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
      '@thenewlabs/entangle-protocol': resolve(__dirname, './packages/protocol/src'),
      '@thenewlabs/entangle-crypto': resolve(__dirname, './packages/crypto/src'),
      '@thenewlabs/entangle-utils': resolve(__dirname, './packages/utils/src'),
    },
  },
});