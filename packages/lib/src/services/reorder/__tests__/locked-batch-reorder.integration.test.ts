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
 * The second test below forces genuine contention with a deliberate
 * `pg_sleep` while each transaction holds its locks — without that, a bare
 * `Promise.all([runOne, runTwo])` has no guarantee the two transactions ever
 * actually hold overlapping locks at the same time (Postgres could run one
 * to completion before the other's locking select even arrives), which would
 * let the test pass "vacuously" — proving nothing about lock contention —
 * even against a broken implementation. The forced hold guarantees real
 * row-lock blocking/serialization happens on every run (observable as the
 * test's duration jumping to roughly the sleep length), not just that both
 * promises happened to resolve.
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
 * "never deadlock" assertion under forced contention below, not a manual
 * probe of Postgres's incidental scan order.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { driveRoles } from '@pagespace/db/schema/members';
import { factories } from '@pagespace/db/test/factories';
import { computeReorderPlan } from '../compute-reorder-plan';
import { lockedBatchReorder } from '../locked-batch-reorder';

let dbAvailable = false;

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

    // Whichever transaction wins the race to lock first holds its locks for
    // this long before committing — forcing the OTHER transaction's locking
    // select to genuinely arrive and block while those overlapping rows are
    // still held, instead of the two transactions merely running back-to-back
    // without ever actually contending. See the file-level doc comment.
    const runOne = db.transaction(async (tx) => {
      await lockedBatchReorder(tx, {
        table: driveRoles,
        idColumn: driveRoles.id,
        positionColumn: driveRoles.position,
        scopeWhere: eq(driveRoles.driveId, drive.id),
        plan: planOne,
      });
      await tx.execute(sql`SELECT pg_sleep(0.3)`);
    });
    const runTwo = db.transaction(async (tx) => {
      await lockedBatchReorder(tx, {
        table: driveRoles,
        idColumn: driveRoles.id,
        positionColumn: driveRoles.position,
        scopeWhere: eq(driveRoles.driveId, drive.id),
        plan: planTwo,
      });
      await tx.execute(sql`SELECT pg_sleep(0.3)`);
    });

    // The deadlock-absence proof: firing both concurrently against overlapping
    // rows — with the forced hold above guaranteeing they genuinely contend —
    // must not raise Postgres error 40P01 (deadlock detected). One
    // transaction blocking behind the other's row lock is correct
    // serialization, not a failure — but neither may be aborted by the
    // deadlock detector.
    await Promise.all([runOne, runTwo]);

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
