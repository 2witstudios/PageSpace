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
      '@pagespace/lib/logger-config': path.resolve(packagesDir, 'lib/src/logging/logger-config'),
      '@pagespace/lib/permissions-cached': path.resolve(packagesDir, 'lib/src/permissions/permissions-cached'),
      '@pagespace/lib/security': path.resolve(packagesDir, 'lib/src/security'),
      '@pagespace/lib': path.resolve(packagesDir, 'lib/src'),
    },
  },
})
