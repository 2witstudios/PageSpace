import { defineConfig } from 'vitest/config';
import path from 'path';

// Integration-test config: includes files that the default config excludes
// because they require a running Postgres. Invoke with:
//   ./scripts/test-with-db.sh or manually after migrations:
//   bun --filter '@pagespace/db' run vitest run --config vitest.integration.config.ts
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.test.{js,ts}'],
    setupFiles: ['./src/test/setup.ts'],
    fileParallelism: false,
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
