import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

// Kept as its own binding (rather than inline under `coverage.thresholds`)
// because scripts/test-coverage-sharded.mjs and ../../scripts/coverage-ratchet.mjs
// both regex-parse this exact block directly from this file's source text —
// do not change its shape (the ratchet-marker comments below, or the
// per-glob object literal syntax) without checking both scripts. Do not
// write the two marker comments adjacent to each other anywhere else in
// this file (even in prose) — both scripts' regexes match the FIRST
// occurrence, and a second one earlier in the file would shadow the real
// block.
const coverageThresholds = {
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
}

export default defineConfig({
  plugins: [react()],
  test: {
    // The default 'threads' pool runs workers as node:worker_threads, which do
    // NOT inherit --max-old-space-size from NODE_OPTIONS the way a separate
    // process does — each worker's V8 isolate keeps its own (unraised) heap
    // ceiling regardless of the parent's flags. 'forks' spawns real child
    // processes instead, so CI's NODE_OPTIONS heap bump (see ci.yml) actually
    // takes effect.
    pool: 'forks',
    // The coverage run's memory footprint could not be solved by tuning fork
    // count and heap ceiling within a single `vitest run` invocation — every
    // combination tried either crashed 1-2 forks near the end, OOM-killed the
    // whole job, or destabilized the runner itself (a ~53min GC-thrashing hang
    // and a ~12min unresponsive stall, both ending in an external shutdown
    // signal — see git history on this file and ci.yml for the full trail,
    // including a reverted attempt at the 'istanbul' coverage provider that
    // silently broke 100%-threshold guarantees via different branch counting).
    // `coverage.all: false` (below) measurably helped but wasn't sufficient
    // alone. The actual fix is structural: package.json's `test:coverage` runs
    // scripts/test-coverage-sharded.mjs instead of `vitest run --coverage`
    // directly — it runs the suite in 3 sequential shards so each shard's
    // fork pool fully tears down (releasing its accumulated coverage memory)
    // before the next starts, bounding peak memory to roughly a third of the
    // whole suite at any moment instead of the whole thing at once.
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
      // A per-shard run (VITEST_COVERAGE_SHARD, set only by
      // scripts/test-coverage-sharded.mjs) must not self-enforce these — its
      // own file subset isn't the right denominator for thresholds calibrated
      // against the whole suite. The sharding script re-checks these exact
      // values itself after merging all shards' coverage. A plain
      // `vitest run --coverage` (no sharding) still enforces normally.
      thresholds: process.env.VITEST_COVERAGE_SHARD ? undefined : coverageThresholds,
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
