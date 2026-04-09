import { defineConfig } from 'vitest/config'
import path from 'path'

const packagesDir = path.resolve(__dirname, '../../packages')

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,ts,tsx}'],
  },
  resolve: {
    alias: {
      '@pagespace/lib/security': path.resolve(packagesDir, 'lib/src/security'),
      '@pagespace/lib': path.resolve(packagesDir, 'lib/src'),
    },
  },
})
