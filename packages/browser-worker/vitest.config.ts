import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * `@pagespace/lib` subpaths resolve to lib's SOURCE here, so the decision
 * suites run without a lib dist build (CI builds it anyway; the worktree
 * need not). The modules this package imports from lib are themselves pure.
 */
const libSource = { find: /^@pagespace\/lib\/(.*)$/, replacement: `${path.resolve(__dirname, '../lib/src')}/$1` };

export default defineConfig({
  resolve: { alias: [libSource] },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Integration suites drive a real Chromium (local substrate) or a real
    // remote substrate; they run through their own config, never here.
    exclude: ['src/**/*.integration.test.ts', '**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: './coverage',
      reportOnFailure: true,
      include: ['src/decide-*.ts', 'src/reduce-*.ts', 'src/verify-*.ts', 'src/encode-*.ts', 'src/parse-*.ts'],
      exclude: ['**/*.d.ts', '**/__tests__/**'],
      // The pure decision modules are the security boundary of this package
      // (Control Board §7): every branch of every decision is a table row.
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
