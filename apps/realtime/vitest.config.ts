import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,ts}'],
    // Real-Postgres tests run only under vitest.integration.config.ts (`bun run test:integration`).
    exclude: ['**/node_modules/**', 'src/**/*.integration.test.ts'],
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
        // Sentry bootstrap: must be the process's first import and needs a real
        // DSN side effect, so no test can execute it meaningfully.
        'src/instrument.ts',
        // The composition root: 25 inline socket handlers plus the listen/shutdown
        // wiring, exercised for real by the integration config and smoke boot, not
        // meaningfully by unit suites.
        'src/index.ts',
      ],
      thresholds: {
        lines: 75,
        branches: 98,
        functions: 85,
        statements: 75,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})