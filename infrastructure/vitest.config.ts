import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/__tests__/**/*.test.ts', '__tests__/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
