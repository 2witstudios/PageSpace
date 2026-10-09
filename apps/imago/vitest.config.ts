import { defineConfig } from 'vitest/config';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');

export default defineConfig({
  // tsconfig keeps JSX for Next (jsx: preserve); tests compile it like Next does.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // Need a live Postgres: run by vitest.integration.config.ts (test:integration).
    exclude: ['src/**/*.integration.test.{ts,tsx}'],
    // CI runs `turbo run test:coverage`; json-summary feeds coverage-report.mjs.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: './coverage',
      reportOnFailure: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', '**/*.d.ts', 'src/retained/**'],
      // The provenance-locked classic copies keep their tests in this run, but
      // their coverage belongs to web. These unchanged floors govern Imago's
      // native code AND every new boundary adapter. The all-source audit and
      // real retained-feature interactions are recorded in docs/imago/verification.md.
      // Floors at what the suite measures; raise them as coverage rises,
      // never lower them to make a change fit. The layout and request-nonce
      // are server-only and proven against a running server instead.
      thresholds: {
        lines: 82,
        statements: 82,
        branches: 93,
        functions: 85,
      },
    },
  },
  resolve: {
    // Workspace packages from source, as the tsconfig paths resolve them.
    alias: [
      { find: /^@pagespace\/browser-worker\/(.+)$/, replacement: path.resolve(repoRoot, 'packages/browser-worker/src/$1') },
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: /^@pagespace\/db\/(.+)$/, replacement: path.resolve(repoRoot, 'packages/db/src/$1') },
      { find: /^@pagespace\/lib\/(.+)$/, replacement: path.resolve(repoRoot, 'packages/lib/src/$1') },
      { find: /^@pagespace\/editor\/(.+)$/, replacement: path.resolve(repoRoot, 'packages/editor/src/$1') },
    ],
  },
});
