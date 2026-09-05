/**
 * `drive_envs` store — REAL Postgres.
 *
 * The unit suite drives the env services against an in-memory fake, which is
 * the right tool for the lifecycle orderings and proves NOTHING about the two
 * things this PR's correctness actually rests on:
 *
 *  1. **The delete guard's row lock.** `deleteIfUnoccupied` claims that taking
 *     `SELECT ... FOR UPDATE` on the env row makes the live-session count
 *     atomic with the delete, because binding a session needs `FOR KEY SHARE`
 *     on that same row for its FK and the two conflict. That is a claim about
 *     Postgres lock semantics. A fake cannot agree or disagree with it; only
 *     two real connections racing can.
 *  2. **The create ceiling's advisory lock.** Same shape: the per-payer
 *     `pg_advisory_xact_lock` is what stops two differently-named creates from
 *     both landing past the ceiling, and it either serializes them in Postgres
 *     or it does not.
 *
 * Both are the P1 findings from review, so both are pinned here against a real
 * database rather than against a model of one.
 *
 * Also covers the SQL the fake silently gets right where JS and SQL differ: the
 * `IS NULL` compare-and-swap semantics, and the AFTER DELETE reclaim trigger's
 * WHEN clause.
 *
 * Runs in CI (the Unit Tests job provides Postgres). Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test -- src/services/drive-envs/__tests__/drive-envs-store.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { driveEnvLocal } from '@pagespace/db/schema/drive-env-local';
import { agentWorkspaces } from '@pagespace/db/schema/agent-workspaces';
import { machineSpriteReclaims } from '@pagespace/db/schema/machine-sprite-reclaims';
import { createDbDriveEnvStore } from '../drive-envs-store';

/**
 * A SECOND, INDEPENDENT CONNECTION — the only way to observe a lock.
 *
 * `db` is one pooled client here, and a test that used it for both sides of a
 * lock would either deadlock against itself or prove nothing. `pg` is not
 * hoisted for this package, so it is resolved through `@pagespace/db`'s own
 * module context — the same physical driver the db package uses.
 */
import { createRequire } from 'node:module';
const requireFromTest = createRequire(import.meta.url);
const requireFromDb = createRequire(requireFromTest.resolve('@pagespace/db/db'));
const { Pool } = requireFromDb('pg') as unknown as {
  Pool: new (config: Record<string, unknown>) => {
    connect(): Promise<{
      query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
      release(): void;
    }>;
    end(): Promise<void>;
  };
};
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

const payerId = createId();
const otherPayerId = createId();
const driveId = createId();
const secondDriveId = createId();
const otherDriveId = createId();
/** Every sandbox name this file lets reach the DB — the reclaim outbox is FK-less, so teardown must sweep it by name. */
const sandboxIds = new Set<string>();

let store: Awaited<ReturnType<typeof createDbDriveEnvStore>>;

async function seedEnv(
  over: Partial<{
    driveId: string;
    name: string;
    sandboxId: string;
    spriteInstanceId: string | null;
    spriteTornDownAt: Date;
  }> = {},
): Promise<string> {
  const id = createId();
  if (over.sandboxId) sandboxIds.add(over.sandboxId);
  await db.insert(driveEnvs).values({
    id,
    driveId: over.driveId ?? driveId,
    name: over.name ?? `env-${id.slice(0, 8)}`,
    createdBy: payerId,
    sandboxId: over.sandboxId ?? null,
    spriteInstanceId: over.spriteInstanceId ?? null,
    spriteTornDownAt: over.spriteTornDownAt ?? null,
    updatedAt: new Date(),
  });
  return id;
}

/** A live (not-ended) session bound to an env — what the delete guard counts. */
async function seedSessionInEnv(envId: string, endedAt: Date | null = null): Promise<string> {
  const id = createId();
  await db.insert(agentWorkspaces).values({
    id,
    driveId,
    ownerId: payerId,
    envId,
    endedAt,
    updatedAt: new Date(),
  });
  return id;
}

beforeAll(async () => {
  store = await createDbDriveEnvStore();
  await db.insert(users).values([
    { id: payerId, email: `env-payer-${payerId}@test.local`, name: 'Env Payer', updatedAt: new Date() },
    { id: otherPayerId, email: `env-other-${otherPayerId}@test.local`, name: 'Other Payer', updatedAt: new Date() },
  ]).onConflictDoNothing();
  await db.insert(drives).values([
    { id: driveId, name: 'Env Drive', slug: `env-drive-${driveId}`, ownerId: payerId, updatedAt: new Date() },
    { id: secondDriveId, name: 'Env Drive 2', slug: `env-drive2-${secondDriveId}`, ownerId: payerId, updatedAt: new Date() },
    { id: otherDriveId, name: 'Other Drive', slug: `other-drive-${otherDriveId}`, ownerId: otherPayerId, updatedAt: new Date() },
  ]).onConflictDoNothing();
});

beforeEach(async () => {
  await db.delete(agentWorkspaces).where(eq(agentWorkspaces.ownerId, payerId));
  for (const drive of [driveId, secondDriveId, otherDriveId]) {
    await db.delete(driveEnvs).where(eq(driveEnvs.driveId, drive));
  }
  if (sandboxIds.size > 0) {
    await db.delete(machineSpriteReclaims).where(inArray(machineSpriteReclaims.sandboxId, [...sandboxIds]));
  }
});

afterAll(async () => {
  await db.delete(agentWorkspaces).where(eq(agentWorkspaces.ownerId, payerId));
  for (const drive of [driveId, secondDriveId, otherDriveId]) {
    await db.delete(driveEnvs).where(eq(driveEnvs.driveId, drive));
  }
  if (sandboxIds.size > 0) {
    await db.delete(machineSpriteReclaims).where(inArray(machineSpriteReclaims.sandboxId, [...sandboxIds]));
  }
  await db.delete(drives).where(inArray(drives.id, [driveId, secondDriveId, otherDriveId]));
  await db.delete(users).where(inArray(users.id, [payerId, otherPayerId]));
  await pool.end();
});

describe('deleteIfUnoccupied — the live-session guard, for real', () => {
  it('given a live session, should refuse and leave the row', async () => {
    const envId = await seedEnv();
    await seedSessionInEnv(envId);

    const result = await store.deleteIfUnoccupied({ envId, force: false });

    expect(result).toEqual({ ok: false, reason: 'live_sessions', liveSessionCount: 1 });
    const [row] = await db.select().from(driveEnvs).where(eq(driveEnvs.id, envId)).limit(1);
    expect(row).toBeDefined();
  });

  it('given only ENDED sessions, should delete — and the cascade takes them with it', async () => {
    const envId = await seedEnv();
    const endedId = await seedSessionInEnv(envId, new Date());

    const result = await store.deleteIfUnoccupied({ envId, force: false });

    expect(result).toEqual({ ok: true });
    const sessions = await db.select().from(agentWorkspaces).where(eq(agentWorkspaces.id, endedId));
    expect(sessions).toHaveLength(0);
  });

  it('given force, should delete AND cascade the live sessions away', async () => {
    const envId = await seedEnv();
    const liveId = await seedSessionInEnv(envId);

    expect(await store.deleteIfUnoccupied({ envId, force: true })).toEqual({ ok: true });

    const sessions = await db.select().from(agentWorkspaces).where(eq(agentWorkspaces.id, liveId));
    expect(sessions).toHaveLength(0);
  });

  it('should BLOCK on an in-flight session insert, then SEE it — the store\'s own row lock closing the TOCTOU window', async () => {
    // THE P1, driven through the store rather than around it. The claim is a
    // Postgres lock-semantics claim: `deleteIfUnoccupied`'s `FOR UPDATE` on the
    // env row conflicts with the `FOR KEY SHARE` an `agent_workspaces` insert
    // must take on that same row for its FK.
    //
    // Without that lock the store would not block, would count zero (the
    // insert is uncommitted and therefore invisible), and would DELETE the row
    // — cascading away a session that commits a moment later. This test fails
    // exactly that way if `.for('update')` is dropped, which is what makes it a
    // test of the fix and not of Postgres.
    const envId = await seedEnv();
    const spawnId = createId();

    const spawner = await pool.connect();
    try {
      // A session binds to this env, and HOLDS the transaction open.
      await spawner.query('BEGIN');
      await spawner.query(
        // `now() at time zone 'utc'`, not bare `now()`: these timestamp columns
        // store UTC wall-clock, while `now()` is a timestamptz resolved through
        // the session's TZ — so a non-UTC connection writes local time into a
        // column everything else reads as UTC. Invisible on UTC CI, wrong
        // anywhere else, and the repo rule exists because that asymmetry has
        // bitten claim/expiry predicates before.
        `INSERT INTO agent_workspaces (id, "driveId", "ownerId", "envId", "updatedAt")
         VALUES ($1,$2,$3,$4,(now() at time zone 'utc'))`,
        [spawnId, driveId, payerId, envId],
      );

      let settled = false;
      const deleting = store.deleteIfUnoccupied({ envId, force: false }).then((result) => {
        settled = true;
        return result;
      });

      // The delete must be WAITING on the row lock, not racing past it.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);

      await spawner.query('COMMIT');

      // Released, and the count now sees the session that committed.
      expect(await deleting).toEqual({ ok: false, reason: 'live_sessions', liveSessionCount: 1 });
      const [row] = await db.select().from(driveEnvs).where(eq(driveEnvs.id, envId)).limit(1);
      expect(row).toBeDefined();
    } finally {
      spawner.release();
    }
  });

  it('given force, should still take the lock and delete through an in-flight bind', async () => {
    // Forcing skips the COUNT, not the lock — the FK-holding insert is
    // serialized behind the delete either way, and then fails against a row
    // that is gone. A spawn racing the deletion of its own env failing is the
    // correct outcome.
    const envId = await seedEnv();
    const spawnId = createId();
    const spawner = await pool.connect();
    try {
      await spawner.query('BEGIN');
      await spawner.query(
        // `now() at time zone 'utc'`, not bare `now()`: these timestamp columns
        // store UTC wall-clock, while `now()` is a timestamptz resolved through
        // the session's TZ — so a non-UTC connection writes local time into a
        // column everything else reads as UTC. Invisible on UTC CI, wrong
        // anywhere else, and the repo rule exists because that asymmetry has
        // bitten claim/expiry predicates before.
        `INSERT INTO agent_workspaces (id, "driveId", "ownerId", "envId", "updatedAt")
         VALUES ($1,$2,$3,$4,(now() at time zone 'utc'))`,
        [spawnId, driveId, payerId, envId],
      );
      const deleting = store.deleteIfUnoccupied({ envId, force: true });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await spawner.query('COMMIT');
      expect(await deleting).toEqual({ ok: true });
    } finally {
      spawner.release();
    }
    const rows = await db.select().from(agentWorkspaces).where(eq(agentWorkspaces.id, spawnId));
    expect(rows).toHaveLength(0);
  });

  it('given two CONCURRENT deletes, should let exactly one win and tell the other the truth', async () => {
    // The row lock serializes them, so this is deterministic rather than racy:
    // the loser blocks, then re-checks under READ COMMITTED and finds the row
    // gone. Reporting `not_found` rather than a second success is what keeps
    // `spriteTornDown` honest — only one call actually killed anything.
    const envId = await seedEnv();

    const [first, second] = await Promise.all([
      store.deleteIfUnoccupied({ envId, force: false }),
      store.deleteIfUnoccupied({ envId, force: false }),
    ]);

    expect([first, second].filter((r) => r.ok)).toHaveLength(1);
    expect([first, second].filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'not_found' }]);
  });

  it('given the row is gone, should report not_found rather than a phantom success', async () => {
    expect(await store.deleteIfUnoccupied({ envId: createId(), force: false })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('the AFTER DELETE reclaim trigger', () => {
  it('given a row that still believes it is live, should enqueue its pointer', async () => {
    const sandboxId = `pgs-env-live-${createId()}`;
    const envId = await seedEnv({ sandboxId, spriteInstanceId: 'inst-1' });

    await store.deleteIfUnoccupied({ envId, force: false });

    const [reclaim] = await db
      .select()
      .from(machineSpriteReclaims)
      .where(eq(machineSpriteReclaims.sandboxId, sandboxId))
      .limit(1);
    expect(reclaim?.spriteInstanceId).toBe('inst-1');
  });

  it('given a CONFIRMED torn-down row, should enqueue nothing — no chasing a dead name', async () => {
    const sandboxId = `pgs-env-dead-${createId()}`;
    const envId = await seedEnv({ sandboxId, spriteInstanceId: 'inst-1', spriteTornDownAt: new Date() });

    await store.deleteIfUnoccupied({ envId, force: false });

    const reclaims = await db
      .select()
      .from(machineSpriteReclaims)
      .where(eq(machineSpriteReclaims.sandboxId, sandboxId));
    expect(reclaims).toHaveLength(0);
  });
});

describe('createIfUnderLimit — the ceiling, for real', () => {
  it('given the payer is under the ceiling, should mint', async () => {
    const result = await store.createIfUnderLimit({
      driveId,
      name: 'staging',
      createdBy: payerId,
      now: new Date(),
      payerId,
      maxEnvs: 2,
    });
    expect(result.ok).toBe(true);
  });

  it('given the payer is AT the ceiling, should refuse — counted across every drive they own', async () => {
    // The count is per PAYER, not per drive: envs in a second drive of the same
    // owner consume the same allowance.
    await seedEnv({ driveId, name: 'a' });
    await seedEnv({ driveId: secondDriveId, name: 'b' });

    const result = await store.createIfUnderLimit({
      driveId,
      name: 'c',
      createdBy: payerId,
      now: new Date(),
      payerId,
      maxEnvs: 2,
    });
    expect(result).toEqual({ ok: false, reason: 'limit_reached' });
  });

  it('should not count ANOTHER payer\'s environments', async () => {
    await seedEnv({ driveId: otherDriveId, name: 'theirs' });
    const result = await store.createIfUnderLimit({
      driveId,
      name: 'mine',
      createdBy: payerId,
      now: new Date(),
      payerId,
      maxEnvs: 1,
    });
    expect(result.ok).toBe(true);
  });

  it('should serialize on the PER-PAYER advisory lock — held from outside, the create waits', async () => {
    // THE OTHER P1, pinned deterministically rather than by racing. Holding the
    // exact key `createIfUnderLimit` takes, from an independent connection,
    // must block it: that proves both that the lock is taken at all and that
    // its key is the per-PAYER one. A missing lock does not block (the create
    // returns immediately), and neither does a per-DRIVE key — which is the
    // subtly wrong version, since one payer's two drives would then race past
    // a ceiling defined across both.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`drive-env-create:${payerId}`]);

      let settled = false;
      const creating = store
        .createIfUnderLimit({ driveId, name: 'dev', createdBy: payerId, now: new Date(), payerId, maxEnvs: 5 })
        .then((result) => {
          settled = true;
          return result;
        });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);

      await holder.query('COMMIT');
      expect((await creating).ok).toBe(true);
    } finally {
      holder.release();
    }
  });

  it('should NOT contend with another payer\'s create — the lock is per payer, not global', async () => {
    // The other half of the key claim: a global lock would serialize unrelated
    // payers, turning env creation into a deployment-wide bottleneck.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`drive-env-create:${otherPayerId}`]);

      const result = await store.createIfUnderLimit({
        driveId,
        name: 'dev',
        createdBy: payerId,
        now: new Date(),
        payerId,
        maxEnvs: 5,
      });

      expect(result.ok).toBe(true);
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }
  });

  it('given MANY concurrent creates at the ceiling, should let exactly the remaining slots through', async () => {
    // The behavioral form of the same guarantee: `(driveId, name)` uniqueness
    // cannot serialize `env-0` against `env-1`, so the ceiling has to come from
    // the lock. Six concurrent creates, two slots left, exactly two winners.
    await seedEnv({ driveId, name: 'existing-a' });
    await seedEnv({ driveId, name: 'existing-b' });

    const attempts = await Promise.all(
      Array.from({ length: 6 }, (_unused, index) =>
        store.createIfUnderLimit({
          driveId,
          name: `race-${index}`,
          createdBy: payerId,
          now: new Date(),
          payerId,
          maxEnvs: 4,
        }),
      ),
    );

    expect(attempts.filter((attempt) => attempt.ok)).toHaveLength(2);
    const rows = await db.select().from(driveEnvs).where(eq(driveEnvs.driveId, driveId));
    expect(rows).toHaveLength(4);
  });

  it('given a duplicate NAME, should answer name_taken rather than throwing — drizzle wraps the driver error', async () => {
    // The wrapped-`cause` case: `drizzle-orm@0.45.2` rethrows the driver's
    // 23505 inside `DrizzleQueryError`, so a top-level `.code` test would let
    // this escape as a 500 instead of the 409 the route sends.
    await seedEnv({ driveId, name: 'staging' });
    const result = await store.createIfUnderLimit({
      driveId,
      name: 'staging',
      createdBy: payerId,
      now: new Date(),
      payerId,
      maxEnvs: 10,
    });
    expect(result).toEqual({ ok: false, reason: 'name_taken' });
  });
});

describe('rename — the same wrapped-violation path', () => {
  it('given the new name is taken in the drive, should answer name_taken', async () => {
    await seedEnv({ driveId, name: 'prod' });
    const envId = await seedEnv({ driveId, name: 'dev' });

    expect(await store.rename({ envId, name: 'prod', now: new Date() })).toEqual({
      ok: false,
      reason: 'name_taken',
    });
  });

  it('given the same name in ANOTHER drive, should allow it — uniqueness is per drive', async () => {
    await seedEnv({ driveId: secondDriveId, name: 'prod' });
    const envId = await seedEnv({ driveId, name: 'dev' });

    const result = await store.rename({ envId, name: 'prod', now: new Date() });
    expect(result.ok).toBe(true);
  });
});

describe('the Sprite-identity CAS, in SQL', () => {
  it('given the row has no sandbox, should record only against a NULL previous pointer', async () => {
    // `eqOrIsNull`: SQL `=` never matches NULL, so a plain `eq` here would make
    // every first provision silently lose its own CAS.
    const sandboxId = `pgs-env-cas-${createId()}`;
    sandboxIds.add(sandboxId);
    const envId = await seedEnv();

    const recorded = await store.updateSpriteIdentity({
      envId,
      previousSandboxId: null,
      spriteKey: sandboxId,
      sandboxId,
      spriteInstanceId: 'inst-1',
      egressPolicyToken: null,
      stamps: { lastActiveAt: new Date(), teardownRequestedAt: null, spriteTornDownAt: null },
      now: new Date(),
    });

    expect(recorded).toBe(true);
    const [row] = await db.select().from(driveEnvs).where(eq(driveEnvs.id, envId)).limit(1);
    expect(row.sandboxId).toBe(sandboxId);
  });

  it('given a STALE previous pointer, should refuse — the loser of a concurrent provision', async () => {
    const sandboxId = `pgs-env-held-${createId()}`;
    sandboxIds.add(sandboxId);
    const envId = await seedEnv({ sandboxId, spriteInstanceId: 'inst-1' });

    const recorded = await store.updateSpriteIdentity({
      envId,
      previousSandboxId: null,
      spriteKey: 'other-key',
      sandboxId: `pgs-env-other-${createId()}`,
      spriteInstanceId: 'inst-2',
      egressPolicyToken: null,
      stamps: {},
      now: new Date(),
    });

    expect(recorded).toBe(false);
  });

  it('should CAS the teardown stamp on the INSTANCE, not merely the name', async () => {
    const sandboxId = `pgs-env-teardown-${createId()}`;
    sandboxIds.add(sandboxId);
    const envId = await seedEnv({ sandboxId, spriteInstanceId: 'inst-2' });

    // Stale expectation — a concurrent re-provision moved the instance.
    const stale = await store.stampSpriteTornDown({
      envId,
      sandboxId,
      spriteInstanceId: 'inst-1',
      stamps: { spriteTornDownAt: new Date() },
    });
    expect(stale).toBe(false);

    const current = await store.stampSpriteTornDown({
      envId,
      sandboxId,
      spriteInstanceId: 'inst-2',
      stamps: { spriteTornDownAt: new Date() },
    });
    expect(current).toBe(true);
  });
});

describe('list — the drive-scoped listing, in SQL', () => {
  it('should return ONLY this drive\'s envs — a listing that crossed drives would be a leak', async () => {
    // The fake filters by `driveId` because it was written to; this proves the
    // actual WHERE clause does. Envs are drive-owned and a drive's members see
    // its machines, so a listing that reached into a sibling drive — even one
    // owned by the same payer — would show infrastructure the requester was
    // never authorized for.
    await seedEnv({ driveId, name: 'mine-a' });
    await seedEnv({ driveId, name: 'mine-b' });
    await seedEnv({ driveId: secondDriveId, name: 'same-payer-other-drive' });
    await seedEnv({ driveId: otherDriveId, name: 'other-payer' });

    const rows = await store.list(driveId);

    expect(rows.map((row) => row.name).sort()).toEqual(['mine-a', 'mine-b']);
  });

  it('should order OLDEST first — an env name is an address, so the row must not move under the reader', async () => {
    const older = await seedEnv({ driveId, name: 'first' });
    const newer = await seedEnv({ driveId, name: 'second' });
    // Force a definite ordering rather than relying on insert timing.
    await db.update(driveEnvs).set({ createdAt: new Date('2026-01-01T00:00:00Z') }).where(eq(driveEnvs.id, older));
    await db.update(driveEnvs).set({ createdAt: new Date('2026-06-01T00:00:00Z') }).where(eq(driveEnvs.id, newer));

    const rows = await store.list(driveId);

    expect(rows.map((row) => row.id)).toEqual([older, newer]);
  });

  it('given a drive with no envs, should return empty rather than everything', async () => {
    await seedEnv({ driveId, name: 'somewhere-else' });
    expect(await store.list(otherDriveId)).toEqual([]);
  });
});

describe('countLiveSessionsInEnv / countEnvsOwnedBy', () => {
  it('should count only NOT-ENDED sessions in this env', async () => {
    const envId = await seedEnv();
    const otherEnvId = await seedEnv({ name: 'other' });
    await seedSessionInEnv(envId);
    await seedSessionInEnv(envId, new Date());
    await seedSessionInEnv(otherEnvId);

    expect(await store.countLiveSessionsInEnv(envId)).toBe(1);
  });

  it('should count envs through DRIVE ownership, across every drive the payer owns', async () => {
    await seedEnv({ driveId, name: 'a' });
    await seedEnv({ driveId: secondDriveId, name: 'b' });
    await seedEnv({ driveId: otherDriveId, name: 'theirs' });

    expect(await store.countEnvsOwnedBy(payerId)).toBe(2);
    expect(await store.countEnvsOwnedBy(otherPayerId)).toBe(1);
  });
});

describe('the local-env identity slice — compare-and-set predicates, in SQL', () => {
  // The fake models these as map writes; what matters in production is that
  // each write is ONE guarded UPDATE, so two replicas enrolling or redeeming
  // the same machine resolve to exactly one winner.
  const NOW = new Date('2026-09-05T10:00:00.000Z');
  const facts = (enrollmentId: string) => ({ ownerId: payerId, label: 'jono-macstudio', enrollmentId, enrollmentCodeHash: 'hash', enrollmentCodeExpiresAt: new Date(NOW.getTime() + 600_000) });

  async function createLocal(name = 'mac') {
    const enrollmentId = `enr_${createId()}`;
    const created = await store.createIfUnderLimit({ driveId, name, createdBy: payerId, now: NOW, payerId, maxEnvs: 10, local: facts(enrollmentId) });
    if (!created.ok) throw new Error(created.reason);
    return { envId: created.env.id, enrollmentId, created };
  }

  it('given local facts, should mint the env as substrate local AND its sibling in the same step, returning both', async () => {
    const { envId, enrollmentId, created } = await createLocal();
    expect(created.env.substrate).toBe('local');
    expect(created.local).toMatchObject({ envId, driveId, ownerId: payerId, label: 'jono-macstudio', enrollmentId, enrollmentCodeHash: 'hash', enrolledAt: null, machinePublicKey: null });
    const [row] = await db.select().from(driveEnvLocal).where(eq(driveEnvLocal.envId, envId));
    expect(row?.substrate).toBe('local');
  });

  it('given no local facts, should mint a Sprite env with local: null and no sibling', async () => {
    const created = await store.createIfUnderLimit({ driveId, name: 'cloud', createdBy: payerId, now: NOW, payerId, maxEnvs: 10 });
    if (!created.ok) throw new Error(created.reason);
    expect(created.env.substrate).toBe('sprite');
    expect(created.local).toBeNull();
    expect(await db.select().from(driveEnvLocal).where(eq(driveEnvLocal.envId, created.env.id))).toEqual([]);
  });

  it('given a local create that loses the name to a duplicate, should leave NO sibling behind (one transaction)', async () => {
    await seedEnv({ driveId, name: 'taken' });
    const created = await store.createIfUnderLimit({ driveId, name: 'taken', createdBy: payerId, now: NOW, payerId, maxEnvs: 10, local: facts(`enr_${createId()}`) });
    expect(created).toEqual({ ok: false, reason: 'name_taken' });
    const orphans = await db.select({ envId: driveEnvLocal.envId }).from(driveEnvLocal).innerJoin(driveEnvs, eq(driveEnvs.id, driveEnvLocal.envId)).where(eq(driveEnvs.driveId, driveId));
    expect(orphans).toEqual([]);
  });

  it('findLocalByEnrollmentId / listLocalFacts: should join the drive id and scope the listing to the drive', async () => {
    const { envId, enrollmentId } = await createLocal('a');
    await store.createIfUnderLimit({ driveId: otherDriveId, name: 'theirs', createdBy: otherPayerId, now: NOW, payerId: otherPayerId, maxEnvs: 10, local: { ...facts(`enr_${createId()}`), ownerId: otherPayerId } });
    expect((await store.findLocalByEnrollmentId(enrollmentId))?.envId).toBe(envId);
    expect(await store.findLocalByEnrollmentId('enr_nope')).toBeNull();
    expect((await store.listLocalFacts(driveId)).map((r) => r.envId)).toEqual([envId]);
  });

  it('pinMachineKey: should enroll ONCE — the second attempt loses the compare-and-set, and a revoked row cannot be enrolled at all', async () => {
    const { envId } = await createLocal();
    const pin = { envId, machinePublicKey: 'pk', machineKeyFingerprint: 'sha256:fp', serverKeyId: 'k1', now: NOW };
    expect(await store.pinMachineKey(pin)).toBe(true);
    const [row] = await db.select().from(driveEnvLocal).where(eq(driveEnvLocal.envId, envId));
    expect(row).toMatchObject({ machinePublicKey: 'pk', machineKeyFingerprint: 'sha256:fp', serverKeyId: 'k1', enrollmentCodeHash: null });
    expect(row?.enrolledAt?.getTime()).toBe(NOW.getTime());
    expect(row?.enrollmentCodeUsedAt?.getTime()).toBe(NOW.getTime());
    expect(await store.pinMachineKey({ ...pin, machinePublicKey: 'pk2' })).toBe(false);
    expect((await db.select().from(driveEnvLocal).where(eq(driveEnvLocal.envId, envId)))[0]?.machinePublicKey).toBe('pk');

    const other = await createLocal('revoked');
    await db.update(driveEnvLocal).set({ revokedAt: NOW }).where(eq(driveEnvLocal.envId, other.envId));
    expect(await store.pinMachineKey({ ...pin, envId: other.envId })).toBe(false);
  });

  it('setChallenge: should refuse before enrollment, then store the nonce, replacing a previous one and clearing its consumption', async () => {
    const { envId } = await createLocal();
    expect(await store.setChallenge({ envId, nonce: 'n1', expiresAt: NOW, now: NOW })).toBe(false);
    await store.pinMachineKey({ envId, machinePublicKey: 'pk', machineKeyFingerprint: 'fp', serverKeyId: 'k1', now: NOW });
    expect(await store.setChallenge({ envId, nonce: 'n1', expiresAt: NOW, now: NOW })).toBe(true);
    expect(await store.consumeChallenge({ envId, nonce: 'n1', now: NOW })).toBe(true);
    expect(await store.setChallenge({ envId, nonce: 'n2', expiresAt: NOW, now: NOW })).toBe(true);
    const [row] = await db.select().from(driveEnvLocal).where(eq(driveEnvLocal.envId, envId));
    expect(row?.challengeNonce).toBe('n2');
    expect(row?.challengeUsedAt).toBeNull();
  });

  it('consumeChallenge: given the enrollment was REVOKED after the challenge was issued, should lose the compare-and-set — revocation wins the race, nothing mints', async () => {
    const { envId } = await createLocal();
    await store.pinMachineKey({ envId, machinePublicKey: 'pk', machineKeyFingerprint: 'fp', serverKeyId: 'k1', now: NOW });
    await store.setChallenge({ envId, nonce: 'n1', expiresAt: NOW, now: NOW });
    await db.update(driveEnvLocal).set({ revokedAt: NOW }).where(eq(driveEnvLocal.envId, envId));
    expect(await store.consumeChallenge({ envId, nonce: 'n1', now: NOW })).toBe(false);
    const [row] = await db.select().from(driveEnvLocal).where(eq(driveEnvLocal.envId, envId));
    expect(row?.challengeUsedAt).toBeNull();
    expect(row?.lastSeenAt).toBeNull();
  });

  it('consumeChallenge: should consume exactly the outstanding nonce ONCE, stamping lastSeenAt; a wrong nonce or a replay loses', async () => {
    const { envId } = await createLocal();
    await store.pinMachineKey({ envId, machinePublicKey: 'pk', machineKeyFingerprint: 'fp', serverKeyId: 'k1', now: NOW });
    await store.setChallenge({ envId, nonce: 'n1', expiresAt: NOW, now: NOW });
    expect(await store.consumeChallenge({ envId, nonce: 'wrong', now: NOW })).toBe(false);
    const later = new Date(NOW.getTime() + 5_000);
    expect(await store.consumeChallenge({ envId, nonce: 'n1', now: later })).toBe(true);
    expect(await store.consumeChallenge({ envId, nonce: 'n1', now: later })).toBe(false);
    const [row] = await db.select().from(driveEnvLocal).where(eq(driveEnvLocal.envId, envId));
    expect(row?.challengeUsedAt?.getTime()).toBe(later.getTime());
    expect(row?.lastSeenAt?.getTime()).toBe(later.getTime());
  });
});
