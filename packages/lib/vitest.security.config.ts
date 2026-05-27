import { defineConfig } from 'vitest/config';

// Config for DB-backed security integration tests excluded from the standard
// unit-test run. Used by the security CI workflow which has a live Postgres.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
