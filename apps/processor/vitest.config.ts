import { defineConfig } from 'vitest/config'
import path from 'path'

const packagesDir = path.resolve(__dirname, '../../packages')

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      reportOnFailure: true,
      exclude: [
        '**/*.d.ts',
        '**/*.config.*',
        '**/dist/**',
        '**/test/**',
        '**/drizzle/**',
        '**/node_modules/**',
      ],
      thresholds: {
        lines: 50,
        branches: 89,
        functions: 66,
        statements: 50,
      },
    },
  },
  resolve: {
    alias: {
      '@pagespace/db': path.resolve(packagesDir, 'db/src'),
      '@pagespace/lib/logging/logger-config': path.resolve(packagesDir, 'lib/src/logging/logger-config'),
      '@pagespace/lib/permissions': path.resolve(packagesDir, 'lib/src/permissions'),
      '@pagespace/lib/security': path.resolve(packagesDir, 'lib/src/security'),
      '@pagespace/lib': path.resolve(packagesDir, 'lib/src'),
    },
  },
})
