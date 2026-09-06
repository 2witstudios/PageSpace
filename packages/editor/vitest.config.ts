import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // The package itself constructs without a DOM (that is its contract —
    // see eslint.config.mjs), but its tests parse HTML fixtures through
    // ProseMirror's DOMParser, which needs a real `DOMParser`/`document`.
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: './coverage',
      reportOnFailure: true,
      exclude: ['**/*.d.ts', '**/*.config.*', '**/dist/**', '**/node_modules/**'],
      thresholds: {
        lines: 71,
        branches: 94,
        functions: 53,
        statements: 71,
      },
    },
  },
});
