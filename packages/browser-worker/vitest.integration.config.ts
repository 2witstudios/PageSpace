import { defineConfig } from 'vitest/config';

/**
 * Adapter suites (Control Board §7.3): each drives the real thing it adapts —
 * a real Chromium over a debugging pipe, a real egress proxy on a loopback
 * socket, a real worker process. They are slower and need a Chromium build
 * (`bunx playwright install chromium` from apps/e2e), so they run here and
 * not in the unit config.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
