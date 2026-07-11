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
    // Fit the web suite's memory on the 16 GB CI runner. With `isolate: true`
    // (needed — the suite's files vi.mock overlapping modules differently and do
    // not reset mocks, so registries can't be shared) each file retains its full
    // module graph, ~48 MB/file of REAL accumulation, released only when its
    // shard process exits. vitest packs files onto forks unevenly — one fork was
    // seen running an entire shard while the others sat idle — so a fork's heap
    // must be able to hold a whole shard, but the shard's total data is what
    // actually lives in RAM (it does not multiply by fork count; idle forks hold
    // almost nothing). CI confirmed a single fork churns through an ENTIRE shard
    // of fast files, and the per-file retention VARIES by shard (heavy
    // component-render files cluster into some shards, ~50–80 MB/file). So use
    // ten sequential shards to spread the heavy files thin (~84 files/shard) and
    // a generous 12 GB per-fork cap: even a worst-case ~100 MB/file shard is
    // ~8 GB, well under both the cap and the runner's RAM. Each shard is a fresh
    // process that releases everything before the next; the `test` script's 8 GB
    // main-process heap covers post-shard aggregation.
    pool: 'forks',
    poolOptions: { forks: { execArgv: ['--max-old-space-size=12288'] } },
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
