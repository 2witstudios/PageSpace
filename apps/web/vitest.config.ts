import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    moduleDirectories: ['node_modules', path.resolve(__dirname, '../../node_modules')],
    globals: true,
    environment: 'jsdom',
    css: true,
    include: ['src/**/*.{test,spec}.{js,ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      // CI measures coverage of files the tests actually execute; it does not
      // instrument the whole app (`all: false`). Under `all: true` v8 loads and
      // instruments every source file — thousands, most untested — purely to
      // print them as 0%. On a 16 GB runner that inflates both per-worker
      // collection and the final merge past the heap limit. The thresholds below
      // are the gate and still hold on the executed set (tested-code coverage is
      // well above them). Local runs keep the full picture for exploration.
      all: !process.env.CI,
      // CI also skips the per-file `html`/`json` reporters (memory-heavy to
      // render); `json-summary` is retained for the coverage-ratchet tooling.
      reporter: process.env.CI
        ? ['text', 'json-summary']
        : ['text', 'json', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      reportOnFailure: true,
      exclude: [
        '**/*.d.ts',
        '**/*.config.*',
        '**/.next/**',
        '**/dist/**',
        '**/test/**',
        '**/drizzle/**',
        '**/node_modules/**',
      ],
      thresholds: {
        lines: 44,
        branches: 85,
        functions: 56,
        statements: 44,
      },
    },
  },
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: 'server-only', replacement: path.resolve(__dirname, 'src/test/server-only-stub.ts') },
      { find: 'next/server', replacement: path.resolve(__dirname, 'src/test/next-server-stub.ts') },
    ],
  },
})
