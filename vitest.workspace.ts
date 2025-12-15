import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  {
    test: {
      name: '@pagespace/lib',
      root: './packages/lib',
      environment: 'node',
      globals: true,
    },
  },
  {
    test: {
      name: 'web',
      root: './apps/web',
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
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