import { defineConfig } from 'vitest/config'
import path from 'path'

// Real-Postgres tests (need DATABASE_URL → a migrated database). Invoke with:
//   bun run test:integration
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
