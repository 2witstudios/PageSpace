import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx,js,jsx}'],
    setupFiles: ['./src/test/setup.ts'],
    // Run test files sequentially to avoid database race conditions
    fileParallelism: false,
    coverage: {
      reporter: ['text', 'json', 'html'],
    },
  },
});
