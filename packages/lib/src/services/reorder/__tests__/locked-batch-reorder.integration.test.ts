/**
 * lockedBatchReorder concurrency integration test (real Postgres).
 *
 * Drives the REAL lockedBatchReorder against a real database — no fake DB, no
 * vi.mock. This is the primitive that replaces the N-sequential-unordered-update
 * loop that deadlocked production Postgres on 2026-07-18 (task_items.position,
 * ~7-minute deadlock storm, 17:30-17:37 UTC). The property under test is the one
 * a mocked test cannot prove: two concurrent reorders touching OVERLAPPING rows,
 * each submitted in an order that does not match the other's, must never raise a
 * Postgres deadlock error — the ascending-id `FOR UPDATE` lock order
 * (computeReorderPlan + lockedBatchReorder) serializes them instead.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). Skipped when no DB is reachable.
 *
 * The second test below proves genuine row-lock contention deterministically
 * rather than inferring it from timing. Two dangers with a timing-based
 * approach (e.g. a fixed `pg_sleep` while holding locks): (1) if the app's
 * connection pool is configured with `DB_POOL_MAX=1` (a supported config in
 * packages/db/src/db.ts), both `db.transaction()` calls draw from the SAME
 * one-connection pool, so the second transaction can't even start until the
 * first releases its connection — they'd never reach Postgres concurrently
 * at all, and the test would pass without ever exercising contention; (2) a
 * loaded CI runner can delay the second transaction's query past any fixed
 * sleep window regardless of pool size. Both would let the test pass
 * "vacuously" — proving nothing — even against a broken implementation.
 *
 * Fixed here with two changes: each transaction gets its own dedicated
 * single-connection `pg.Pool`, independent of the app's shared pool and its
 * `DB_POOL_MAX` setting, so both are always able to reach Postgres
 * concurrently regardless of production pool tuning; and instead of a fixed
 * sleep, the test polls `pg_stat_activity` for `wait_event_type = 'Lock'` on
 * whichever side didn't win the race to lock first — an explicit,
 * timing-independent proof that real row-lock blocking occurred — before
 * releasing the winner. If that proof is never observed within the poll
 * window, the test fails loudly rather than passing vacuously.
 *
 * NOTE (manual lock proof, verified): temporarily dropping only the
 * `.orderBy(asc(idColumn))` from lockedBatchReorder's `FOR UPDATE` select
 * does NOT reliably reproduce a deadlock here — verified by hand. Postgres's
 * `id = ANY(...)` filter against the primary-key index already visits rows
 * in a consistent order for both concurrently-running queries regardless of
 * an explicit ORDER BY, at least for a table this small, so both
 * transactions still end up acquiring the shared rows in the same relative
 * order and never form a wait cycle. The ORDER BY is still the right,
 * theory-backed defense (a consistent lock order provably rules out circular
 * wait; an "it happened not to reorder this time" default scan order does
 * not, and could differ under a different query plan, index choice, or table
 * size) — mirrors `lockDriveRolesInOrder`'s doc comment in
 * drive-role-service.ts — but don't trust a quick local edit as a
 * regression check for it; this file's real regression coverage is the
 * "never deadlock" assertion under proven contention below, not a manual
 * probe of Postgres's incidental scan order.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { schema } from '@pagespace/db/schema';
import { driveRoles } from '@pagespace/db/schema/members';
import { factories } from '@pagespace/db/test/factories';
import { computeReorderPlan } from '../compute-reorder-plan';
import { lockedBatchReorder } from '../locked-batch-reorder';

let dbAvailable = false;

// Tuning for the deterministic contention proof in the "never deadlock" test
// below: how long to wait for both sides' backend pids, and the poll
// interval/attempt budget for observing genuine lock contention via
// pg_stat_activity (~3s total: CONTENTION_POLL_MAX_ATTEMPTS *
// CONTENTION_POLL_INTERVAL_MS).
const PID_WAIT_INTERVAL_MS = 5;
const CONTENTION_POLL_MAX_ATTEMPTS = 150;
const CONTENTION_POLL_INTERVAL_MS = 20;

describe('lockedBatchReorder concurrency (Postgres row lock)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(driveRoles).limit(1);
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  it('applies every position in one pass, independent of caller-submitted order', async () => {
    if (!dbAvailable) return;
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const roles = await db
      .insert(driveRoles)
      .values([
        { driveId: drive.id, name: 'role-a', permissions: {}, position: 0 },
        { driveId: drive.id, name: 'role-b', permissions: {}, position: 1 },
        { driveId: drive.id, name: 'role-c', permissions: {}, position: 2 },
      ])
      .returning();

    const plan = computeReorderPlan([
      { id: roles[2].id, position: 10 },
      { id: roles[0].id, position: 11 },
      { id: roles[1].id, position: 12 },
    ]);

    let lockedIds: string[] = [];
    await db.transaction(async (tx) => {
      lockedIds = await lockedBatchReorder(tx, {
        table: driveRoles,
        idColumn: driveRoles.id,
        positionColumn: driveRoles.position,
        scopeWhere: eq(driveRoles.driveId, drive.id),
        plan,
      });
    });

    expect([...lockedIds].sort()).toEqual([...plan.orderedIds].sort());

    const updated = await db.select().from(driveRoles).where(eq(driveRoles.driveId, drive.id));
    const positionById = new Map(updated.map((r) => [r.id, r.position]));
    expect(positionById.get(roles[0].id)).toBe(11);
    expect(positionById.get(roles[1].id)).toBe(12);
    expect(positionById.get(roles[2].id)).toBe(10);
  });

  it('returns only the ids that actually existed in scope, leaving out-of-scope ids un-updated', async () => {
    if (!dbAvailable) return;
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const otherDrive = await factories.createDrive(owner.id);
    const [inScope] = await db
      .insert(driveRoles)
      .values([{ driveId: drive.id, name: 'role-in-scope', permissions: {}, position: 0 }])
      .returning();
    const [outOfScope] = await db
      .insert(driveRoles)
      .values([{ driveId: otherDrive.id, name: 'role-out-of-scope', permissions: {}, position: 0 }])
      .returning();

    // Plan names a real row from another drive alongside the in-scope one —
    // scopeWhere excludes it, so it must not be reported as locked or updated.
    const plan = computeReorderPlan([
      { id: inScope.id, position: 5 },
      { id: outOfScope.id, position: 6 },
    ]);

    let lockedIds: string[] = [];
    await db.transaction(async (tx) => {
      lockedIds = await lockedBatchReorder(tx, {
        table: driveRoles,
        idColumn: driveRoles.id,
        positionColumn: driveRoles.position,
        scopeWhere: eq(driveRoles.driveId, drive.id),
        plan,
      });
    });

    expect(lockedIds).toEqual([inScope.id]);

    const [updatedInScope] = await db.select().from(driveRoles).where(eq(driveRoles.id, inScope.id));
    const [updatedOutOfScope] = await db.select().from(driveRoles).where(eq(driveRoles.id, outOfScope.id));
    expect(updatedInScope.position).toBe(5);
    expect(updatedOutOfScope.position).toBe(0);
  });

  it('two concurrent reorders touching overlapping rows in different orders never deadlock', async () => {
    if (!dbAvailable) return;
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const roles = await db
      .insert(driveRoles)
      .values([
        { driveId: drive.id, name: 'role-1', permissions: {}, position: 0 },
        { driveId: drive.id, name: 'role-2', permissions: {}, position: 1 },
        { driveId: drive.id, name: 'role-3', permissions: {}, position: 2 },
        { driveId: drive.id, name: 'role-4', permissions: {}, position: 3 },
      ])
      .returning();

    // Sort by actual id so we know the true ascending lock order, independent
    // of insertion order.
    const sorted = [...roles].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    const [a, b, c, d] = sorted;

    // Overlapping-but-not-identical row sets — {a,b,c} vs {b,c,d} — each
    // submitted in an order that does NOT match ascending-id. computeReorderPlan
    // normalizes both to ascending order; that shared order is exactly what
    // keeps two concurrent, overlapping writers from deadlocking.
    const planOne = computeReorderPlan([
      { id: c.id, position: 100 },
      { id: a.id, position: 101 },
      { id: b.id, position: 102 },
    ]);
    const planTwo = computeReorderPlan([
      { id: d.id, position: 200 },
      { id: b.id, position: 201 },
      { id: c.id, position: 202 },
    ]);

    // Dedicated single-connection pools, independent of the shared app
    // pool's DB_POOL_MAX — see the file-level doc comment for why. `ssl`
    // mirrors packages/db/src/db.ts's basePoolConfig() exactly (not
    // exported, so replicated here): without it, an environment that
    // requires DATABASE_SSL=true would fail this test's connections with a
    // TLS error instead of exercising reorder locking, even though the
    // shared `db` pool used for setup/polling above connects fine.
    const ssl = process.env.DATABASE_SSL === 'true' ? ({ rejectUnauthorized: false } as const) : false;
    const poolOne = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, ssl });
    const poolTwo = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, ssl });
    const dbOne = drizzle(poolOne, { schema });
    const dbTwo = drizzle(poolTwo, { schema });

    try {
      const pids: { one: number | null; two: number | null } = { one: null, two: null };
      // Set exactly once, by whichever side's lockedBatchReorder call
      // resolves first — that side won the race to lock, so it pauses here
      // (holding its locks open) until the test explicitly releases it.
      // Whichever side is still stuck inside lockedBatchReorder at that
      // point must be genuinely blocked waiting on these same rows.
      let firstToLock: 'one' | 'two' | null = null;
      let releaseFirst: (() => void) | null = null;
      const releaseSignal = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      const makeRun = (side: 'one' | 'two', sideDb: typeof dbOne, plan: typeof planOne) =>
        sideDb.transaction(async (tx) => {
          const pidRows = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
          pids[side] = Number((pidRows.rows[0] as { pid: string | number }).pid);

          await lockedBatchReorder(tx, {
            table: driveRoles,
            idColumn: driveRoles.id,
            positionColumn: driveRoles.position,
            scopeWhere: eq(driveRoles.driveId, drive.id),
            plan,
          });

          if (firstToLock === null) {
            firstToLock = side;
            await releaseSignal;
          }
        });

      const runOne = makeRun('one', dbOne, planOne);
      const runTwo = makeRun('two', dbTwo, planTwo);

      // If either side rejects (e.g. a connection failure) before the PID
      // barrier or contention poll below would otherwise notice, this wins
      // the race and surfaces the real error immediately — instead of the
      // barrier/poll spinning until Vitest's test timeout, hiding the actual
      // cause behind a generic "timed out" failure.
      const earlyFailure: Promise<never> = Promise.race([runOne, runTwo]).then(
        () => new Promise<never>(() => {}), // a resolution here is not a failure; never let it win the race
        (err) => {
          throw err;
        }
      );

      let observedBlockedPid: number | null = null;
      try {
        // Backend pids are assigned before either side's locking select, so
        // this resolves almost immediately — not a contention wait.
        const waitForPids = (async () => {
          while (pids.one === null || pids.two === null) {
            await new Promise((resolve) => setTimeout(resolve, PID_WAIT_INTERVAL_MS));
          }
        })();
        await Promise.race([waitForPids, earlyFailure]);

        // The deterministic contention proof: poll until whichever side
        // didn't win the lock race shows as genuinely blocked on a Postgres
        // lock. The assertion below fails the test if that's never observed,
        // rather than the loop spinning silently forever.
        const pollForContention = (async () => {
          for (let i = 0; i < CONTENTION_POLL_MAX_ATTEMPTS && observedBlockedPid === null; i++) {
            const activity = await db.execute(sql`
              SELECT pid, wait_event_type FROM pg_stat_activity
              WHERE pid IN (${pids.one}, ${pids.two})
            `);
            for (const row of activity.rows as { pid: number; wait_event_type: string | null }[]) {
              if (row.wait_event_type === 'Lock') {
                observedBlockedPid = row.pid;
                break;
              }
            }
            if (observedBlockedPid === null) {
              await new Promise((resolve) => setTimeout(resolve, CONTENTION_POLL_INTERVAL_MS));
            }
          }
        })();
        await Promise.race([pollForContention, earlyFailure]);

        expect(observedBlockedPid).not.toBeNull();
      } finally {
        // Always release the winner — whether contention was observed, the
        // poll ran out, the assertion above threw, or either side rejected
        // early — so its transaction can settle instead of hanging forever
        // on `releaseSignal`, which would otherwise leave its connection
        // permanently checked out and make `poolOne.end()`/`poolTwo.end()`
        // below hang too, turning a useful failure into an opaque timeout.
        releaseFirst!();
      }

      // The deadlock-absence proof: with genuine contention already proven
      // above, both transactions must still resolve without Postgres error
      // 40P01 (deadlock detected). The side that was blocked simply proceeds
      // once the winner commits — correct serialization, not a failure.
      // Settled (not `Promise.all`) so both always finish releasing their
      // connections before the pools close below, even if one rejects.
      const [resultOne, resultTwo] = await Promise.allSettled([runOne, runTwo]);
      if (resultOne.status === 'rejected') throw resultOne.reason;
      if (resultTwo.status === 'rejected') throw resultTwo.reason;
    } finally {
      await poolOne.end();
      await poolTwo.end();
    }

    const updated = await db.select().from(driveRoles).where(eq(driveRoles.driveId, drive.id));
    const positionById = new Map(updated.map((r) => [r.id, r.position]));

    // Non-overlapping rows always reflect their sole writer.
    expect(positionById.get(a.id)).toBe(101);
    expect(positionById.get(d.id)).toBe(200);

    // Overlapping rows (b, c) were written by whichever transaction committed
    // last — but must reflect ONE consistent transaction's pair, never a mix
    // of the two (which would mean the batched update wasn't atomic).
    const bPos = positionById.get(b.id);
    const cPos = positionById.get(c.id);
    const matchesPlanOne = bPos === 102 && cPos === 100;
    const matchesPlanTwo = bPos === 201 && cPos === 202;
    expect(matchesPlanOne || matchesPlanTwo).toBe(true);
  });

  it('stamps touchColumns with the current time, bypassing nothing Drizzle would have set', async () => {
    if (!dbAvailable) return;
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const stale = new Date('2020-01-01T00:00:00Z');
    const roles = await db
      .insert(driveRoles)
      .values([
        { driveId: drive.id, name: 'role-x', permissions: {}, position: 0, updatedAt: stale },
        { driveId: drive.id, name: 'role-y', permissions: {}, position: 1, updatedAt: stale },
      ])
      .returning();

    const plan = computeReorderPlan([
      { id: roles[0].id, position: 5 },
      { id: roles[1].id, position: 6 },
    ]);

    const before = Date.now();
    await db.transaction(async (tx) => {
      await lockedBatchReorder(tx, {
        table: driveRoles,
        idColumn: driveRoles.id,
        positionColumn: driveRoles.position,
        scopeWhere: eq(driveRoles.driveId, drive.id),
        plan,
        touchColumns: [driveRoles.updatedAt],
      });
    });

    const updated = await db.select().from(driveRoles).where(eq(driveRoles.driveId, drive.id));
    for (const role of updated) {
      expect(role.updatedAt.getTime()).toBeGreaterThan(stale.getTime());
      expect(role.updatedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    }
  });

  it('stamps touchColumns with the write-time clock, not the transaction-start snapshot (clock_timestamp, not now())', async () => {
    if (!dbAvailable) return;
    // Regression test for a P2 Codex finding on PR #2139: `now()` (aka
    // `transaction_timestamp()`) is fixed at this transaction's BEGIN and
    // stays fixed for every statement inside it, including the touchColumns
    // UPDATE. If the transaction is delayed between BEGIN and the write (in
    // production: blocked waiting on the FOR UPDATE lock behind a concurrent
    // role mutation), `now()` would stamp a timestamp from before that
    // delay — potentially older than a concurrent writer's own commit,
    // silently regressing `updatedAt` backwards. `clock_timestamp()`
    // reflects the actual wall-clock moment the UPDATE executes, so it must
    // reflect time elapsed *inside* the transaction, not just its start.
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const role = (
      await db
        .insert(driveRoles)
        .values([{ driveId: drive.id, name: 'role-clock', permissions: {}, position: 0 }])
        .returning()
    )[0];

    const plan = computeReorderPlan([{ id: role.id, position: 7 }]);
    const IN_TX_DELAY_MS = 150;

    let checkpoint = 0;
    await db.transaction(async (tx) => {
      // Forces Postgres to actually issue BEGIN now, rather than pipelining
      // it with the first "real" statement below — without this, the delay
      // that follows wouldn't elapse any time *inside* the open transaction
      // from Postgres's point of view, and now() vs clock_timestamp() would
      // be indistinguishable.
      await tx.execute(sql`SELECT 1`);
      // Elapses real wall-clock time after BEGIN (which already fixed
      // now()/transaction_timestamp()) but before the touchColumns write —
      // standing in for time spent blocked on the row lock in production.
      await new Promise((resolve) => setTimeout(resolve, IN_TX_DELAY_MS));
      checkpoint = Date.now();

      await lockedBatchReorder(tx, {
        table: driveRoles,
        idColumn: driveRoles.id,
        positionColumn: driveRoles.position,
        scopeWhere: eq(driveRoles.driveId, drive.id),
        plan,
        touchColumns: [driveRoles.updatedAt],
      });
    });

    const [updated] = await db.select().from(driveRoles).where(eq(driveRoles.id, role.id));
    // A margin well under IN_TX_DELAY_MS: with now(), the stamp would trail
    // checkpoint by roughly IN_TX_DELAY_MS; with clock_timestamp(), it lands
    // at-or-after checkpoint.
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(checkpoint - 50);
  });

  it('leaves touchColumns untouched (and thus stale) when the caller opts out', async () => {
    if (!dbAvailable) return;
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const stale = new Date('2020-01-01T00:00:00Z');
    const role = (
      await db
        .insert(driveRoles)
        .values([{ driveId: drive.id, name: 'role-z', permissions: {}, position: 0, updatedAt: stale }])
        .returning()
    )[0];

    const plan = computeReorderPlan([{ id: role.id, position: 9 }]);

    await db.transaction(async (tx) => {
      await lockedBatchReorder(tx, {
        table: driveRoles,
        idColumn: driveRoles.id,
        positionColumn: driveRoles.position,
        scopeWhere: eq(driveRoles.driveId, drive.id),
        plan,
      });
    });

    const [updated] = await db.select().from(driveRoles).where(eq(driveRoles.id, role.id));
    expect(updated.position).toBe(9);
    expect(updated.updatedAt.getTime()).toBe(stale.getTime());
  });
});
