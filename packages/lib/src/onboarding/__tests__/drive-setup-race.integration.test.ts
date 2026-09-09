/**
 * populateUserDrive concurrency integration test (real Postgres).
 *
 * Drives the REAL seeder against a real database — no fake DB, no vi.mock. The
 * property under test is the one the unit test provably cannot prove: two
 * seeders racing for the SAME drive must produce ONE seed set.
 *
 * This is not hypothetical. The `drives_home_unique` partial index
 * (packages/db/src/schema/core.ts) exists because two signup paths raced in
 * production and each laid down a full set of starter pages.
 *
 * WHY THE UNIT TEST IS NOT ENOUGH. The two-seeder unit test drives both calls
 * through a database stand-in that serialises transaction bodies
 * unconditionally, so serialisation is *assumed* there rather than
 * demonstrated — removing the `FOR UPDATE` leaves it green. It covers "the
 * seeder does the right thing given serialisation". That the lock is taken, and
 * taken before the existence check, is a separate invocationCallOrder test.
 * Nothing before this file proved Postgres actually serialises the two.
 *
 * TWO WAYS THIS TEST COULD PASS VACUOUSLY, both closed below:
 *
 * 1. A shared connection pool. `packages/db/src/db.ts` supports `DB_POOL_MAX=1`,
 *    under which both `transaction()` calls would draw from the same single
 *    connection and the second could not even begin until the first committed.
 *    They would never reach Postgres concurrently and the test would pass
 *    against a seeder with no lock at all. Each side therefore gets its own
 *    dedicated single-connection `pg.Pool`, independent of app pool tuning.
 *
 * 2. Inferring contention from timing. A fixed sleep proves nothing on a loaded
 *    runner. Instead the loser is observed blocking in `pg_stat_activity` with
 *    `wait_event_type = 'Lock'` — an explicit, timing-independent proof that
 *    real row-lock blocking occurred. If that is never observed, the test fails
 *    loudly rather than passing.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). FAILS LOUDLY when no DB is reachable —
 * a silent skip would be a green, zero-assertion pass. Local runs without
 * Docker opt out explicitly with ALLOW_SKIP_DB_TESTS=1.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { schema } from '@pagespace/db/schema';
import { pages } from '@pagespace/db/schema/core';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { populateUserDrive } from '../drive-setup';

let dbAvailable = false;
const pools: Pool[] = [];

const CONTENTION_POLL_MAX_ATTEMPTS = 150;
const CONTENTION_POLL_INTERVAL_MS = 20;

function dedicatedClient() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  pools.push(pool);
  return drizzle(pool, { schema });
}

describe('populateUserDrive concurrency (Postgres row lock)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('drive-setup-race.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
  });

  it('given two seeders racing for one drive, seeds exactly once', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);

    const [a, b] = await Promise.all([
      populateUserDrive(owner.id, drive.id, dedicatedClient()),
      populateUserDrive(owner.id, drive.id, dedicatedClient()),
    ]);

    // Exactly one seeder claims the work; the loser reads the scope the winner
    // filled and reports it did nothing.
    expect([a.seeded, b.seeded].filter(Boolean)).toHaveLength(1);

    const roots = await db
      .select({ id: pages.id })
      .from(pages)
      .where(eq(pages.driveId, drive.id));

    // The observable failure in production was a DOUBLE set of starter pages.
    const titles = roots.length;
    expect(titles).toBeGreaterThan(0);

    const dupes = await db.execute(sql`
      SELECT title, COUNT(*) AS n FROM ${pages}
      WHERE ${pages.driveId} = ${drive.id}
      GROUP BY title HAVING COUNT(*) > 1
    `);
    expect(dupes.rows).toHaveLength(0);
  });

  it('proves the loser actually blocks on the drive row lock', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);

    const holder = dedicatedClient();
    let release: () => void = () => undefined;
    let announceHeld: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The holder must be PROVEN to own the row before the seeder starts. Without
    // this the two race, the seeder can win, and it then never blocks — the
    // assertion below would fail for a reason that has nothing to do with the
    // seeder's correctness. (Observed: passes alone, fails alongside siblings.)
    const lockHeld = new Promise<void>((resolve) => {
      announceHeld = resolve;
    });

    const holding = holder.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM drives WHERE id = ${drive.id} FOR UPDATE`);
      announceHeld();
      await held;
    });

    await lockHeld;
    const seeding = populateUserDrive(owner.id, drive.id, dedicatedClient());

    let observedLockWait = false;
    for (let attempt = 0; attempt < CONTENTION_POLL_MAX_ATTEMPTS; attempt++) {
      const waiting = await db.execute(sql`
        SELECT 1 FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE%'
      `);
      if (waiting.rows.length > 0) {
        observedLockWait = true;
        break;
      }
      await new Promise((r) => setTimeout(r, CONTENTION_POLL_INTERVAL_MS));
    }

    release();
    await holding;
    await seeding;

    // Without this the first test could pass on a seeder that never locks at
    // all, simply because the two transactions happened not to interleave.
    expect(observedLockWait).toBe(true);
  });
});
