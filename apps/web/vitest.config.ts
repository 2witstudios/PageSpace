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
    // (needed — the suite's files vi.mock overlapping modules differently and
    // do not reset mocks, so registries can't be shared) each file retains its
    // full module graph, ~58 MB/file, released only when its shard process
    // exits. vitest also packs files onto forks unevenly (one fork was seen
    // taking ~50% of a shard). So the `test` script runs TEN sequential shards
    // (~83 files each, separate processes that release all memory between them);
    // even a fork that grabs half a shard holds ~42 files ≈ 2.4 GB, within the
    // 4 GB per-fork cap. The cap also stops forks inheriting the main process's
    // larger NODE_OPTIONS ceiling (V8 lazily grows to whatever it is given) and
    // keeps 4 concurrent forks within the runner's RAM.
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
