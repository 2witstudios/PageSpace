import { defineConfig } from 'vitest/config';

// Integration-test config: includes the service-level integration tests that
// the default config excludes because they require a running Postgres.
// Invoke with:
//   pnpm --filter @pagespace/lib exec vitest run --config vitest.integration.config.ts <file>
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/services/__tests__/*.integration.test.{js,ts}'],
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
