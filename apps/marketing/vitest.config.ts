import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Page tests render .tsx with react-dom/server; no React import in scope.
  esbuild: { jsx: 'automatic' },
  resolve: {
    // Mirror tsconfig.json `paths`: `@/` is this app's src, and lib is read from source.
    alias: [
      { find: /^@\/(.*)$/, replacement: path.resolve(__dirname, 'src/$1') },
      { find: /^@pagespace\/lib\/(.*)$/, replacement: path.resolve(__dirname, '../../packages/lib/src/$1') },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,ts,tsx}'],
  },
})
