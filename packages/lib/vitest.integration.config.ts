import { defineConfig } from 'vitest/config';

// Integration-test config: includes the service-level integration tests that
// the default config excludes because they require a running Postgres.
// Invoke with:
//   bun run --filter '@pagespace/lib' vitest run --config vitest.integration.config.ts <file>
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.test.{js,ts}'],
    // integration-db-teardown ends each file's @pagespace/db pool; without it the
    // isolated files' idle connections exhaust Postgres (53300 too many clients).
    setupFiles: ['./src/test/setup.ts', './src/test/integration-db-teardown.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
