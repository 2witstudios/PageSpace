/**
 * Integration-only setup file (vitest.integration.config.ts).
 *
 * Every integration file runs in an isolated module registry, so each one
 * builds its own `@pagespace/db` pool — up to DB_POOL_MAX (10) connections with
 * a 10-minute idle timeout — and almost none end it. Across ~40 files the idle
 * connections pile up until Postgres refuses the next file with 53300 "too many
 * clients already". Release the pool when each file finishes.
 */
import { afterAll } from 'vitest';
import * as appDb from '@pagespace/db/db';
import { releaseAppPool } from './release-app-pool';

afterAll(async () => {
  // A suite may vi.mock('@pagespace/db/db') with only `db`; reading a missing
  // export off a vitest mock throws, so look it up defensively.
  let pool: typeof appDb.pool | undefined;
  try {
    pool = appDb.pool;
  } catch {
    pool = undefined;
  }
  await releaseAppPool(pool);
});
