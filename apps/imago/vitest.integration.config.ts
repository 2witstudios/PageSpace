import { defineConfig } from 'vitest/config';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');

// Integration config: the *.integration.test.ts suites the default config
// excludes because they need a migrated Postgres at DATABASE_URL. They import
// @pagespace/db and @pagespace/lib from source, as the tsconfig paths do.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.{ts,tsx}'],
    fileParallelism: false,
    pool: 'forks',
  },
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: /^@pagespace\/db\/(.+)$/, replacement: path.resolve(repoRoot, 'packages/db/src/$1') },
      { find: /^@pagespace\/lib\/(.+)$/, replacement: path.resolve(repoRoot, 'packages/lib/src/$1') },
    ],
  },
});
