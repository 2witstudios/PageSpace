import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
    // The admin-DB integration suites (audit chainer, SIEM delivery, backfill
    // flip) each `DROP SCHEMA public CASCADE` on the SAME database that
    // ADMIN_DATABASE_URL names, then re-migrate it. Run concurrently they tear
    // the schema out from under each other — they pass individually and fail
    // together, which reads as a flaky worker rather than a test-harness race.
    // `packages/lib` and `packages/db` already serialize for this exact reason;
    // this package needed it too and did not have it, which stayed invisible
    // for as long as those suites were silently skipping.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    // TZ is part of this package's contract, not incidental. The admin-plane
    // audit columns are `timestamp without time zone`; raw-pg writes serialize
    // a JS Date in the CLIENT's local zone while the read side parses as UTC
    // (`admin-pg-types.ts`), so on a non-UTC process the two disagree and the
    // SIEM preflight reports a false CHAIN TAMPER. The processor deploys under
    // UTC — `admin-pg-types.ts` calls the entrypoint pin a Phase 6 task — so
    // pin it here rather than letting each developer's zone decide whether
    // these suites pass. Without this they are green only in UTC, which is
    // precisely how they stayed green-looking while never running at all.
    env: { TZ: 'UTC' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      reportOnFailure: true,
      exclude: [
        '**/*.d.ts',
        '**/*.config.*',
        '**/dist/**',
        '**/test/**',
        '**/drizzle/**',
        '**/node_modules/**',
      ],
      thresholds: {
        lines: 50,
        branches: 89,
        functions: 66,
        statements: 50,
      },
    },
  },
})
