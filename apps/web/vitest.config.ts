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
    // Use the worker_threads pool, not the default 'forks'. The auth-barrel
    // elimination made ~285 test files load real modules instead of a wholesale
    // barrel mock, so the suite executes ~1500 real modules. Under 'forks' a
    // worker retains each file's module graph and never releases it — unbounded
    // growth that fills any --max-old-space-size and OOMs the 16 GB CI runner.
    // The threads pool tears down each file's context and GCs it, so the test
    // run stays bounded (~2.5 GB) and every test passes. (Full v8 coverage of the
    // whole suite still exceeds a single worker's default heap on the 4-core
    // runner — threads can't raise or recycle that heap — so CI gates web on
    // test correctness and measures web coverage separately; see ci.yml.)
    pool: 'threads',
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
      // Thresholds are checked against the WHOLE suite's coverage. In CI the web
      // suite is run as parallel `--shard`s (each on its own runner, so the
      // executed-coverage remap fits memory — see ci.yml), then their blobs are
      // combined with `--merge-reports`. A single shard only covers ~1/N of the
      // code, so it must NOT enforce thresholds; the shards set COVERAGE_SHARD=1
      // to skip them, and the merge job (and local `test:coverage`) enforces
      // them on the complete, merged coverage.
      thresholds: process.env.COVERAGE_SHARD
        ? undefined
        : {
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
