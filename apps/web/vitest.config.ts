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
    // Use the worker_threads pool, not the default 'forks'. This suite executes
    // ~1500 real modules (the auth-barrel elimination made ~285 test files load
    // real modules instead of a wholesale barrel mock). Under the forks pool a
    // worker retains each file's module graph and never releases it — an
    // unbounded growth that fills any --max-old-space-size and OOMs the 16 GB CI
    // runner during both the run and the v8 coverage remap. The threads pool
    // tears down each file's context and GCs it, so peak memory stays ~2.5 GB
    // and `vitest run --coverage` completes within the default heap.
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
