/**
 * Vitest setup for `vitest.integration.config.ts` ONLY — the unit config keeps
 * `./setup.ts`, because unit tests mock `@pagespace/db/db` and a dynamic import
 * of the real module there would open a real pool.
 *
 * WHY THIS FILE EXISTS. The integration config runs every file in one fork
 * with module isolation, so EVERY test file gets a fresh copy of
 * `@pagespace/db/db` and therefore its own `pg.Pool` (max 10, idle timeout
 * 10 min), and nothing ended those pools until the process exited. Thirty-four
 * files fit under Postgres's default `max_connections = 100`; the three
 * real-Postgres suites the Local Environments GA wave 3 added crossed it, and
 * the file that hit the wall was whichever ran once the budget was gone —
 * `session-repository-resource.integration.test.ts`, untouched by that PR —
 * with FATAL 53300 "sorry, too many clients already". A latent limit in the
 * repo, not a defect in any one suite.
 *
 * So each file ends the pool its module copy opened. Guarded: a suite that
 * already ended the shared pool itself, or never touched the module, is a
 * no-op here (`pg.Pool#end` throws on a second call). `packages/db`'s own
 * integration setup has an `afterAll` that only logs — it stays under the
 * limit because it has fewer files, not because it releases anything.
 */
import './setup';
import { afterAll } from 'vitest';

afterAll(async () => {
  let pool: { end(): Promise<void>; ended?: boolean; ending?: boolean } | undefined;
  try {
    ({ pool } = await import('@pagespace/db/db'));
  } catch {
    // The file `vi.mock`ed the module without a `pool` export (an integration
    // file that drives a fake db, e.g. credits-flow): nothing real was opened.
    return;
  }
  if (!pool || typeof pool.end !== 'function' || pool.ended || pool.ending) return;
  await pool.end().catch(() => undefined);
});
