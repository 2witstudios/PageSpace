import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config'

// Config used ONLY for the per-shard coverage passes (see the `test:coverage`
// script). Each shard covers a fraction of the suite, so its coverage is far
// below the global thresholds — enforcing them here would fail every shard.
// Thresholds are zeroed for the shard passes; the real thresholds (from
// vitest.config) are enforced once on the merged report by the `--merge-reports`
// step. Sharding keeps per-worker coverage memory within the CI runner.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      // Raise the forked coverage workers' V8 heap ceiling. This config is
      // excluded from tsc/next-build (see tsconfig exclude), so the vitest-only
      // poolOptions typing never reaches the app build. NODE_OPTIONS does not
      // propagate to vitest's fork workers, so execArgv is the reliable path.
      poolOptions: {
        forks: {
          execArgv: ['--max-old-space-size=8192'],
        },
      },
      coverage: {
        thresholds: {
          lines: 0,
          branches: 0,
          functions: 0,
          statements: 0,
        },
      },
    },
  }),
)
