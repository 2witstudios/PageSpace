import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ['__tests__/tenant-*.test.ts', '__tests__/cutover-*.test.ts', '__tests__/changelog-*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    deps: {
      // Don't try to transform node_modules — just let Node resolve them
      interopDefault: true,
    },
  },
});
