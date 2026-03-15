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
  './apps/web/vitest.config.ts',
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