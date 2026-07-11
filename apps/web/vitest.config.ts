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
    // Fit the web suite's memory on the 16 GB CI runner. A fork worker's heap
    // grows roughly linearly with the number of files it runs (~17 MB/file, so
    // the whole 833-file suite is ~14 GB of retained module graph however it is
    // split across concurrent forks) — near the runner limit. The `test` script
    // solves this by running the suite in two SEQUENTIAL shards (separate
    // processes that fully release memory between them), so each shard covers
    // ~half the files: ~104 files per fork across the default 4 forks, ~1.7 GB
    // each. The 3 GB per-fork cap both leaves headroom for transient spikes and
    // stops the forks inheriting the main process's larger NODE_OPTIONS ceiling
    // (V8 lazily grows to whatever limit it is given).
    pool: 'forks',
    poolOptions: { forks: { execArgv: ['--max-old-space-size=3072'] } },
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
