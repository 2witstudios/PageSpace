import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // ONE glob, deliberately. This used to be a hand-written list of seven
    // name prefixes, and .github/workflows/ci.yml repeated the same inventory a
    // third time as an explicit file list — three copies that drifted, which is
    // how `tenant-export-columns.test.ts` shipped and then ran nowhere. A new
    // file in `__tests__/` is now run by default; opting one OUT has to be a
    // visible edit here rather than the silence of forgetting to opt it in.
    include: ['__tests__/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    deps: {
      interopDefault: true,
    },
  },
});
