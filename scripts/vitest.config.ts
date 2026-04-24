import { defineConfig } from 'vitest/config';
import path from 'path';

const dbNodeModules = path.resolve(__dirname, '../packages/db/node_modules');

export default defineConfig({
  resolve: {
    alias: [
      { find: '@pagespace/db', replacement: path.resolve(__dirname, '../packages/db/src') },
      { find: '@pagespace/lib', replacement: path.resolve(__dirname, '../packages/lib/src') },
      // drizzle-orm + its transitive deps live under packages/db/node_modules in pnpm strict mode
      { find: /^drizzle-orm($|\/)/, replacement: path.join(dbNodeModules, 'drizzle-orm$1') },
      { find: /^pg($|\/)/, replacement: path.join(dbNodeModules, 'pg$1') },
      { find: /^@paralleldrive\/cuid2$/, replacement: path.join(dbNodeModules, '@paralleldrive/cuid2') },
    ],
  },
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
