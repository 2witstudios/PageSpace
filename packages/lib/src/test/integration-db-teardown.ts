/**
 * Setup file for every packages/lib run that shares one process across files:
 * vitest.integration.config.ts AND the unit vitest.config.ts (singleFork).
 *
 * Every integration file runs in an isolated module registry, so each one
 * builds its own `@pagespace/db` pool — up to DB_POOL_MAX (10) connections with
 * a 10-minute idle timeout — and almost none end it. Across ~40 files the idle
 * connections pile up until Postgres refuses the next file with 53300 "too many
 * clients already". Release the pool when each file finishes.
 */
import { afterAll } from 'vitest';
import { releaseAppPool } from './release-app-pool';

afterAll(async () => {
  // Imported HERE, not at the top of the file: a static import would load the
  // real `@pagespace/db/db` into every file before that file's vi.mock() is
  // registered. By afterAll the test file's own import has run, so this
  // resolves to the same module instance it used (real pool or mock).
  // A suite may vi.mock('@pagespace/db/db') with only `db`; reading a missing
  // export off a vitest mock throws, so look it up defensively.
  let pool: Parameters<typeof releaseAppPool>[0];
  try {
    pool = (await import('@pagespace/db/db')).pool;
  } catch {
    pool = undefined;
  }
  await releaseAppPool(pool);
});
