import { defineConfig } from 'vitest/config'
import path from 'path'

const packagesDir = path.resolve(__dirname, '../../packages')

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@pagespace/db': path.resolve(packagesDir, 'db/src'),
      '@pagespace/lib': path.resolve(packagesDir, 'lib/src'),
    },
  },
})
