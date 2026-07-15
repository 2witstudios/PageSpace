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
    // Trimming the reporters (below) didn't fully fix it either: 2 forks still
    // hit the identical FATAL ERROR after all their assigned tests passed —
    // confirmed via CI log as a graceful per-process V8 ceiling breach (exit
    // code 1, all tests still reported passed), NOT a system-level OOM-kill.
    // Raising maxForks to 8 (tried next) made that per-process crash disappear,
    // but instead caused a genuine system-level OOM-kill (exit 137, "runner has
    // received a shutdown signal") — 8 truly concurrent coverage-instrumented
    // forks summed past the 16GB runner's physical RAM even though no single
    // one hit its own ceiling. That run proved the default (~one fork per CPU,
    // ~3 on this runner) does NOT exceed total system memory — both prior
    // failures at that concurrency were clean, non-signal exits. So: lock
    // concurrency to a known-safe, deliberately low value (rather than trust
    // the runner's exact CPU count) and spend the confirmed headroom entirely
    // on the per-process ceiling (see NODE_OPTIONS in ci.yml) instead of on
    // more parallel forks.
    poolOptions: { forks: { minForks: 3, maxForks: 3 } },
    moduleDirectories: ['node_modules', path.resolve(__dirname, '../../node_modules')],
    globals: true,
    environment: 'jsdom',
    css: true,
    include: ['src/**/*.{test,spec}.{js,ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      // Only coverage-summary.json is ever consumed (coverage-report.mjs,
      // coverage-ratchet.mjs, the CI artifact upload) — 'json' (full raw
      // per-statement maps) and 'html' (syntax-highlighted per-file pages)
      // for this ~930-file suite were dead weight that spiked memory hard
      // during report generation at the tail end of the coverage run.
      reporter: ['text', 'json-summary'],
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
