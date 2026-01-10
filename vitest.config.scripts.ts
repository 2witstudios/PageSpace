import { defineConfig } from 'vitest/config'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['scripts/__tests__/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'apps/**',
      'packages/**',
    ],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
  resolve: {
    alias: {
      '@pagespace/db': path.resolve(__dirname, './packages/db/src'),
      '@pagespace/lib': path.resolve(__dirname, './packages/lib/src'),
    },
  },
})
