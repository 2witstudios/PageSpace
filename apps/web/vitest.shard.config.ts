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
