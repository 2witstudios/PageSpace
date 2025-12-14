import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'
// Note: vite-tsconfig-paths removed due to ESM compatibility issue
// Using manual path alias instead

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
      // Map @pagespace/lib subpath exports to source files
      '@pagespace/lib/ai-monitoring': path.resolve(__dirname, '../../packages/lib/src/monitoring/ai-monitoring.ts'),
      '@pagespace/lib/services/storage-limits': path.resolve(__dirname, '../../packages/lib/src/services/storage-limits.ts'),
      '@pagespace/lib/broadcast-auth': path.resolve(__dirname, '../../packages/lib/src/auth/broadcast-auth.ts'),
      '@pagespace/lib/auth-utils': path.resolve(__dirname, '../../packages/lib/src/auth/auth-utils.ts'),
      '@pagespace/lib/logger-browser': path.resolve(__dirname, '../../packages/lib/src/logging/logger-browser.ts'),
      '@pagespace/lib/utils/environment': path.resolve(__dirname, '../../packages/lib/src/utils/environment.ts'),
      '@pagespace/lib/server': path.resolve(__dirname, '../../packages/lib/src/server.ts'),
      // Fallback for general @pagespace/lib imports
      '@pagespace/lib': path.resolve(__dirname, '../../packages/lib/src'),
      // Map @pagespace/db to source files
      '@pagespace/db': path.resolve(__dirname, '../../packages/db/src'),
    },
  },
})