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
    // grows ~linearly with the number of files it runs (~58 MB/file of retained
    // module graph — the suite releases little between files), and heavy
    // component-render files cluster unevenly across forks, so a fork can hold
    // more than an even split implies. The `test` script runs the suite in six
    // SEQUENTIAL shards (separate processes that fully release memory between
    // them): ~139 files/shard, ~35 per fork across the default 4 forks (~2 GB),
    // and the whole shard's ~8 GB spread across forks. The 4 GB per-fork cap
    // absorbs heavy-file clustering and stops the forks inheriting the main
    // process's larger NODE_OPTIONS ceiling (V8 lazily grows to whatever limit
    // it is given).
    pool: 'forks',
    poolOptions: { forks: { execArgv: ['--max-old-space-size=4096'] } },
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
