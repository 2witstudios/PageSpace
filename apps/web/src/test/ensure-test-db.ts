import { db } from '@pagespace/db/db';
import { sql } from '@pagespace/db/operators';

/**
 * Fail fast — with an actionable message — when a DB-backed test file is run
 * without a provisioned test database.
 *
 * Root `bun run test` starts the dockerized test Postgres (port 5433, see
 * scripts/test-with-db.sh) and exports DATABASE_URL before vitest runs. A
 * direct `bun run --filter web test -- <file>` invocation skips that, falls
 * back to the setup.ts default URL (localhost:5432, role "test"), and every
 * query then dies with a cryptic drizzle "Failed query: insert into ..." /
 * `role "test" does not exist` wall of text that reads like a product bug.
 *
 * Call this from `beforeAll` in any test file that talks to the real
 * database so the very first failure names the actual problem.
 */
export async function ensureTestDb(): Promise<void> {
  try {
    await db.execute(sql`select 1`);
  } catch (err) {
    // Drizzle wraps the pg error ("role \"test\" does not exist",
    // ECONNREFUSED, ...) as `cause` behind a generic "Failed query" message —
    // surface the real one. Connection refusals arrive as an AggregateError
    // with an empty message and the per-address errors in `.errors`.
    const cause = describeError(err);
    throw new Error(
      'Test database not reachable — this test file needs a provisioned test Postgres. ' +
        'Run it via `bun run test` (which starts the dockerized test DB and sets DATABASE_URL), ' +
        'or point DATABASE_URL at a migrated test database ' +
        '(e.g. postgresql://user:password@localhost:5433/pagespace_test if the shared ' +
        `pagespace-postgres-test container is up). Underlying error: ${cause}`,
    );
  }
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.cause instanceof AggregateError && err.cause.errors.length > 0) {
    return err.cause.errors.map((e) => String(e)).join('; ');
  }
  if (err.cause instanceof Error && err.cause.message.length > 0) {
    return err.cause.message;
  }
  return err.message;
}
