import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // CI runs `turbo run test:coverage`; json-summary feeds coverage-report.mjs.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: './coverage',
      reportOnFailure: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', '**/*.d.ts'],
      // Floors at what the suite measures; raise them as coverage rises,
      // never lower them to make a change fit. The layout and request-nonce
      // are server-only and proven against a running server instead.
      thresholds: {
        lines: 72,
        statements: 72,
        branches: 82,
        functions: 84,
      },
    },
  },
  resolve: {
    alias: [{ find: '@', replacement: path.resolve(__dirname, './src') }],
  },
});
