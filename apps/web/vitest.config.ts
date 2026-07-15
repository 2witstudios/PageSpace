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
    // Fork-count/ceiling tuning alone couldn't fix the coverage-run OOM (see
    // this file's and ci.yml's git history for the full trail — 4 different
    // combinations tried: graceful per-process crashes, a system-level OOM-kill
    // at high concurrency, and a ~53-minute GC-thrashing hang at a high ceiling
    // with low, locked concurrency). Switching the coverage provider to
    // 'istanbul' was also tried and reverted: its babel-counter instrumentation
    // counts branches differently than v8's precise coverage, which silently
    // dropped several files below their 100% thresholds (e.g. lines 98.96%,
    // branches 98.02% on src/lib/ai/streams/*.ts) — fixing that would mean
    // writing new tests, out of scope for a CI-infra fix. Addressed the actual
    // memory driver instead: `coverage.all` (see below) was leaving hundreds of
    // never-tested source files instrumented for no reason. Reverted
    // concurrency to the pool's default (proven safe against total system
    // memory across two earlier runs) and kept a modest heap bump as headroom,
    // not as the primary fix.
    moduleDirectories: ['node_modules', path.resolve(__dirname, '../../node_modules')],
    globals: true,
    environment: 'jsdom',
    css: true,
    include: ['src/**/*.{test,spec}.{js,ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      // Defaults to true, which instruments every source file matching
      // include/exclude below — including the ~640 files (1569 non-test source
      // files vs 932 test files, apps/web/src) that no test ever imports or
      // executes. Each one still costs v8 coverage bookkeeping despite
      // contributing nothing but a hardcoded 0% row to the report. Disabling
      // this can only raise or hold steady the computed percentages for
      // thresholds (never lower them — it strictly removes always-0% files
      // from the denominator), so it doesn't risk the ratchet or the 100%
      // per-glob checks; verified locally that the 5 gated globs stay at
      // 100/100/100/100 with this off.
      all: false,
      // Only coverage-summary.json is ever consumed (coverage-report.mjs,
      // coverage-ratchet.mjs, the CI artifact upload) — 'json' (full raw
      // per-statement maps) and 'html' (syntax-highlighted per-file pages)
      // for this suite were dead weight that spiked memory hard during report
      // generation at the tail end of the coverage run.
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
