import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,ts}'],
    exclude: [
      // Integration tests that require a running PostgreSQL database.
      // Run via ./scripts/test-with-db.sh or vitest.integration.config.ts
      // (admin-migrate additionally needs ADMIN_DATABASE_URL → scratch DB).
      'src/**/*.integration.test.ts',
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
        // The /* ratchet:start */.../* ratchet:end */ markers are load-bearing:
        // ../../scripts/coverage-ratchet.mjs rewrites only the four scalars between
        // them. Without the markers its plain-regex fallback would stop at the
        // per-glob sub-object's first `}` below and corrupt this block. Do not
        // remove/move the markers, and do not add new scalar thresholds inside them.
        /* ratchet:start */
        lines: 77,
        branches: 94,
        functions: 0,
        statements: 77,
        /* ratchet:end */
        // Advisory-lock primitive (Server Stream Durability epic, R.4 remediation):
        // the lock/unlock/destroy decision paths are gated at 100% branch.
        'src/advisory-lock.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
        // Pure core behind the destructive-migration pins (#2160): every branch
        // of the SQL analysis is what stops a bad DROP from passing review.
        'src/migration-sql-analysis.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
