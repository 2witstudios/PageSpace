import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'
// Note: vite-tsconfig-paths removed due to ESM compatibility issue
// Using manual path alias instead

const packagesDir = path.resolve(__dirname, '../../packages')

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    css: true,
    include: ['src/**/*.{test,spec}.{js,ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        '**/*.d.ts',
        '**/*.config.*',
        '**/.next/**',
        '**/dist/**',
        '**/test/**',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Workspace package aliases for testing
      '@pagespace/db': path.resolve(packagesDir, 'db/src'),
      '@pagespace/lib/server': path.resolve(packagesDir, 'lib/src/server'),
      '@pagespace/lib/broadcast-auth': path.resolve(packagesDir, 'lib/src/auth/broadcast-auth'),
      '@pagespace/lib/logger-browser': path.resolve(packagesDir, 'lib/src/logging/logger-browser'),
      '@pagespace/lib/utils/environment': path.resolve(packagesDir, 'lib/src/utils/environment'),
      '@pagespace/lib/ai-context-calculator': path.resolve(packagesDir, 'lib/src/monitoring/ai-context-calculator'),
      '@pagespace/lib/ai-monitoring': path.resolve(packagesDir, 'lib/src/monitoring/ai-monitoring'),
      '@pagespace/lib/auth-utils': path.resolve(packagesDir, 'lib/src/auth/auth-utils'),
      '@pagespace/lib/services/subscription-utils': path.resolve(packagesDir, 'lib/src/services/subscription-utils'),
      '@pagespace/lib/services/storage-limits': path.resolve(packagesDir, 'lib/src/services/storage-limits'),
      '@pagespace/lib/verification-utils': path.resolve(packagesDir, 'lib/src/auth/verification-utils'),
      '@pagespace/lib/device-auth-utils': path.resolve(packagesDir, 'lib/src/auth/device-auth-utils'),
      '@pagespace/lib/activity-tracker': path.resolve(packagesDir, 'lib/src/monitoring/activity-tracker'),
      '@pagespace/lib/services/email-service': path.resolve(packagesDir, 'lib/src/services/email-service'),
      '@pagespace/lib/email-templates/VerificationEmail': path.resolve(packagesDir, 'lib/src/email-templates/VerificationEmail'),
      '@pagespace/lib/api-utils': path.resolve(packagesDir, 'lib/src/utils/api-utils'),
      '@pagespace/lib/security': path.resolve(packagesDir, 'lib/src/security'),
      '@pagespace/lib/secure-compare': path.resolve(packagesDir, 'lib/src/auth/secure-compare'),
      '@pagespace/lib/auth': path.resolve(packagesDir, 'lib/src/auth'),
      // Fallback for general @pagespace/lib imports
      '@pagespace/lib': path.resolve(packagesDir, 'lib/src'),
    },
  },
})
