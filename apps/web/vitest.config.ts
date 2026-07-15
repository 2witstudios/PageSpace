import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    // The default 'threads' pool runs workers as node:worker_threads, which do
    // NOT inherit --max-old-space-size from NODE_OPTIONS the way a separate
    // process does — each worker's V8 isolate keeps its own (unraised) heap
    // ceiling regardless of the parent's flags. 'forks' spawns real child
    // processes instead, so CI's NODE_OPTIONS heap bump (see ci.yml) actually
    // takes effect and the v8-coverage-instrumented run of this ~930-file
    // suite no longer crashes with "Ineffective mark-compacts near heap limit".
    pool: 'forks',
    moduleDirectories: ['node_modules', path.resolve(__dirname, '../../node_modules')],
    globals: true,
    environment: 'jsdom',
    css: true,
    include: ['src/**/*.{test,spec}.{js,ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
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
        // The /* ratchet:start */.../* ratchet:end */ markers below are load-bearing:
        // ../../scripts/coverage-ratchet.mjs matches this exact comment-delimited region
        // to rewrite only these four scalars and never touch the per-glob keys after
        // ratchet:end. Do not remove/move the markers, and do not add new scalar
        // thresholds inside them — see that script's header comment for why.
        /* ratchet:start */
        lines: 44,
        branches: 85,
        functions: 56,
        statements: 44,
        /* ratchet:end */
        // Store-first rendering foundations (E1 PR3): new pure modules gated
        // at 100% branch. Single-star globs deliberately exclude __tests__/
        // subdirectories — test files carry their own incidental branches
        // (e.g. it.each fixtures) that have no bearing on source coverage.
        'src/lib/ai/streams/*.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
        'src/stores/useConversationMessagesStore.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
        'src/stores/usePendingStreamsStore.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
        'src/stores/conversationMessages/*.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
        'src/stores/pendingStreams/*.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
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
