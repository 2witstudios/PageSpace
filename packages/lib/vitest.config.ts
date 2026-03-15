import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx,js,jsx}'],
    setupFiles: ['./src/test/setup.ts'],
    // Run test files sequentially to avoid database race conditions
    fileParallelism: false,
    // Use forks pool for process-level module isolation between test files.
    // This prevents vi.mock() in unit tests from contaminating integration
    // tests that use real database connections.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
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
        lines: 66,
        branches: 87,
        functions: 66,
        statements: 66,
      },
    },
  },
});
