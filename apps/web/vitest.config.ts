import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    moduleDirectories: ['node_modules', path.resolve(__dirname, '../../node_modules')],
    globals: true,
    environment: 'jsdom',
    css: true,
    include: ['src/**/*.{test,spec}.{js,ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      reportOnFailure: true,
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
        /* ratchet:start */
        lines: 44,
        branches: 85,
        functions: 56,
        statements: 44,
        /* ratchet:end */
        // Store-first rendering foundations (E1 PR3): new pure modules gated
        // at 100% branch. Single-star globs deliberately exclude __tests__/
        // subdirectories — test files carry their own incidental branches
        // (e.g. it.each fixtures) that have no bearing on source coverage.
        'src/lib/ai/streams/*.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
        'src/stores/useConversationMessagesStore.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
        'src/stores/usePendingStreamsStore.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
        'src/stores/conversationMessages/*.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
        'src/stores/pendingStreams/*.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
      },
    },
  },
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: 'server-only', replacement: path.resolve(__dirname, 'src/test/server-only-stub.ts') },
      { find: 'next/server', replacement: path.resolve(__dirname, 'src/test/next-server-stub.ts') },
    ],
  },
})
