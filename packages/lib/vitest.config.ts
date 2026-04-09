import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx,js,jsx}'],
    exclude: [
      // Integration tests that require a running PostgreSQL database
      'src/__tests__/cross-tenant-escalation.test.ts',
      'src/__tests__/device-auth-utils.test.ts',
      'src/__tests__/file-processor.test.ts',
      'src/__tests__/notifications.test.ts',
      'src/__tests__/permissions.test.ts',
      'src/__tests__/permissions-cached.test.ts',
      'src/__tests__/sheet-new-functions.test.ts',
      'src/auth/magic-link-service.test.ts',
      'src/auth/passkey-service.test.ts',
      'src/auth/__tests__/session-service.test.ts',
      'src/permissions/__tests__/cache-trust-boundaries.test.ts',
      'src/permissions/__tests__/permission-mutations.test.ts',
      'src/permissions/__tests__/zero-trust-boundaries.test.ts',
    ],
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
        lines: 85,
        branches: 94,
        functions: 88,
        statements: 85,
      },
    },
  },
});
