import { defineWorkspace } from 'vitest/config'
import path from 'path'

export default defineWorkspace([
  {
    test: {
      name: 'infrastructure',
      root: '.',
      include: ['infrastructure/**/__tests__/**/*.test.ts'],
      environment: 'node',
      globals: true,
    },
  },
  {
    test: {
      name: '@pagespace/lib',
      root: './packages/lib',
      environment: 'node',
      globals: true,
    },
  },
  {
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'apps/web/src'),
        'server-only': path.resolve(__dirname, 'apps/web/src/test/server-only-stub.ts'),
      },
    },
    test: {
      name: 'web',
      root: './apps/web',
      environment: 'jsdom',
      globals: true,
      css: false,
      setupFiles: ['./src/test/setup.ts'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'html', 'json-summary'],
        reportsDirectory: './apps/web/coverage',
        exclude: [
          '**/*.d.ts',
          '**/*.config.*',
          '**/.next/**',
          '**/dist/**',
          '**/test/**',
          '**/drizzle/**',
          '**/node_modules/**',
        ],
        thresholds: {
          lines: 44,
          branches: 85,
          functions: 56,
          statements: 44,
        },
      },
    },
  },
  {
    test: {
      name: 'realtime',
      root: './apps/realtime',
      environment: 'node',
      globals: true,
    },
  },
  {
    test: {
      name: 'processor',
      root: './apps/processor',
      environment: 'node',
      globals: true,
    },
  },
])