import { defineConfig } from 'vitest/config';

/**
 * Support-level tests for the e2e harness itself (the mock OpenRouter's stream modes).
 * These are plain node tests over HTTP — no browser, no database — so they can run in a
 * worktree without the web app up, unlike the Playwright specs in `tests/`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['support/__tests__/**/*.test.ts'],
  },
});
