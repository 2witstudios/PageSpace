import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,ts}'],
    exclude: [
      // Integration tests that require a running PostgreSQL database.
      // Run via ./scripts/test-with-db.sh, or:
      //   pnpm --filter @pagespace/db test -- src/__tests__/accessible-page-ids.integration.test.ts
      'src/__tests__/accessible-page-ids.integration.test.ts',
    ],
    setupFiles: ['./src/test/setup.ts'],
    // Run test files sequentially to avoid database race conditions
    fileParallelism: false,
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      reportOnFailure: true,
      exclude: [
        '**/*.d.ts',
        '**/*.config.*',
        '**/dist/**',
        '**/test/**',
        '**/drizzle/**',
        '**/node_modules/**',
      ],
      thresholds: {
        lines: 77,
        branches: 94,
        functions: 0,
        statements: 77,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
