import { beforeAll, afterAll } from 'vitest';

// Global test setup
beforeAll(async () => {
  // Suppress log output during tests
  process.env.LOG_LEVEL = 'silent';
  
  // Set test environment
  process.env.NODE_ENV = 'test';
});

afterAll(() => {
  // Clean up any global state
  delete process.env.LOG_LEVEL;
  delete process.env.NODE_ENV;
});