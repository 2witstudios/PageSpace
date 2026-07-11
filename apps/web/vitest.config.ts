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
    // Fit the web suite's memory on the 16 GB CI runner. Fork workers peak
    // DURING test execution; the main process peaks AFTER (forks have exited)
    // while it aggregates 833 files' results — the two peaks don't sum. So:
    //   - cap concurrency at 2 forks, each with a 7 GB heap → ~14 GB during tests
    //   - the `test` script gives the main process 8 GB for the aggregation
    // execArgv also stops the forks inheriting the main's larger NODE_OPTIONS
    // ceiling (V8 lazily grows to whatever limit it is given). 4 concurrent
    // forks at the ~4 GB each file-set needs saturated the runner and OOM'd a
    // worker flakily depending on how test files sharded across them; halving
    // the fork count doubles the files each handles, hence the larger per-fork
    // heap.
    pool: 'forks',
    poolOptions: {
      forks: { execArgv: ['--max-old-space-size=7168'], minForks: 2, maxForks: 2 },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'json-summary'],
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
