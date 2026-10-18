import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One shared embedded cluster for the whole run (see tests/pg.global-setup.ts).
    // Per-test timeouts raised: Windows + parallel Postgres workers are slower than :memory:.
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/pg.global-setup.ts'],
    maxWorkers: 4,
    testTimeout: 30000,
    hookTimeout: 180000,
    teardownTimeout: 30000,
  },
});
