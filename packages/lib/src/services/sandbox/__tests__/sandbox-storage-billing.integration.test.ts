/**
 * Environment persistence billing — REAL Postgres.
 *
 * The unit suites next door drive `reconcileSandboxStorage` against injected
 * fakes, which is right for the accrual arithmetic and the failure isolation and
 * proves nothing about the three things this fold actually rests on:
 *
 *  1. **The env row source's predicate.** `listDriveEnvSprites` claims to
 *     enumerate exactly the envs that still believe they hold a live Sprite.
 *     A fake row array cannot disagree with that claim; a table containing a
 *     never-provisioned env and a torn-down one can.
 *  2. **Attribution to the DRIVE OWNER.** The whole point of the task: an env's
 *     money must land on `drives.ownerId`, resolved by the real
 *     `lookupDriveOwnerId` SQL, and never on `createdBy`. This file seeds an env
 *     whose creator is deliberately NOT the drive owner, so an implementation
 *     that reached for the creator would be caught rather than merely unproven.
 *  3. **The watermark actually advancing on the env row.** `storageLastBilledAt`
 *     is what stops the next run re-billing this window; that it moved is a fact
 *     about an UPDATE, so it is read back out of the table.
 *
 * Money-movement itself is the ONE seam left injected (`chargeStorage`): the
 * credit pipeline is not what this file is proving, and charging real credits to
 * assert an attribution would make the test's own failure mode expensive.
 *
 * Runs in CI (the Unit Tests job provides Postgres) and is deliberately NOT in
 * `vitest.config.ts`'s exclude list — that list feeds `test:coverage`, which is
 * what CI actually runs, so excluding a suite removes it from CI as well as from
 * the local unit run. A billing proof that never executes is worse than no proof,
 * because the green tick still appears.
 *
 * The cost of staying in the run is that a developer without Postgres hits a
 * failure rather than a skip. `requireDb` below makes that failure LOUD and
 * gives the one explicit opt-out (`ALLOW_SKIP_DB_TESTS=1`), which CI never sets
 * — so this can never become a silent, zero-assertion pass.
 *
 * Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test -- src/services/sandbox/__tests__/sandbox-storage-billing.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray, sql } from '@pagespace/db/operators';
import { requireDb, dbSkipExplicitlyAllowed } from '@pagespace/db/test/require-db';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { agentWorkspaces } from '@pagespace/db/schema/agent-workspaces';
import { assert } from './riteway';
import { createDbDriveEnvStore, type DriveEnvStore } from '../../drive-envs/drive-envs-store';
import { defaultReconcileSandboxStorageDeps } from '../sandbox-storage-billing';
import {
  reconcileSandboxStorage,
  MS_PER_STORAGE_MONTH,
  MAX_BILLABLE_SPAN_MS,
  type ReconcileSandboxStorageDeps,
} from '../sandbox-storage-reconcile';

const driveOwnerId = createId();
/** Deliberately NOT the drive owner — `drive_envs.createdBy` is audit only, and this id must never appear on a charge. */
const envCreatorId = createId();
const driveId = createId();

const NOW = new Date('2026-08-18T00:00:00.000Z');
/**
 * The default seeded watermark: exactly one MAX_BILLABLE_SPAN before `NOW`, so a
 * 1GB footprint prices to the largest window a single tick may bill — one day,
 * i.e. `1/30` of a GB-month. Deliberately AT the cap rather than beyond it, so
 * these tests exercise the ordinary path; the clamp itself has its own test.
 */
const ONE_MAX_SPAN_AGO = new Date(NOW.getTime() - MAX_BILLABLE_SPAN_MS);
/** A day's share of a 30-day storage month — what 1GB accrues over one full billable span. */
const ONE_DAY_OF_GB_MONTH = MAX_BILLABLE_SPAN_MS / MS_PER_STORAGE_MONTH;

type ChargeCall = Parameters<ReconcileSandboxStorageDeps['chargeStorage']>[0];

/**
 * The REAL deps, with money movement stubbed. Everything that decides WHO pays
 * and WHAT gets billed — both row sources, the drive-owner lookup, both
 * watermark writes — is the production binding, running against the real table.
 */
function realDepsCapturingCharges(over: Partial<ReconcileSandboxStorageDeps> = {}): {
  deps: ReconcileSandboxStorageDeps;
  charges: ChargeCall[];
} {
  const charges: ChargeCall[] = [];
  return {
    charges,
    deps: {
      ...defaultReconcileSandboxStorageDeps,
      // No agent sessions in this file: the session source is covered by its own
      // suites, and an empty list keeps every assertion below about envs.
      listAgentSessionSprites: async () => [],
      // The REAL query — still production SQL, so the live-Sprite predicate is
      // genuinely under test — narrowed afterwards to this suite's drive.
      //
      // The narrowing is not tidiness. `advanceDriveEnvWatermark` below is also
      // the real one, so an unfiltered listing would ADVANCE THE BILLING
      // WATERMARK of every live env another suite has seeded in a shared CI
      // database — corrupting their state, not merely making this file's counts
      // flaky. Filtering by drive keeps the predicate honest (the
      // never-provisioned and torn-down envs this file seeds are in the SAME
      // drive, so a broken predicate still surfaces them) while making the
      // blast radius exactly this suite's fixtures.
      listDriveEnvSprites: async () =>
        (await defaultReconcileSandboxStorageDeps.listDriveEnvSprites()).filter(
          (row) => row.driveId === driveId,
        ),
      chargeStorage: async (input) => {
        charges.push(input);
      },
      now: () => NOW,
      ...over,
    },
  };
}

async function seedEnv(
  over: Partial<{
    driveId: string;
    name: string;
    sandboxId: string | null;
    spriteInstanceId: string | null;
    spriteTornDownAt: Date | null;
    storageLastBilledAt: Date;
    storageMeasuredBytes: number | null;
    storageMeasuredAt: Date | null;
  }> = {},
): Promise<string> {
  const id = createId();
  await db.insert(driveEnvs).values({
    id,
    driveId: over.driveId ?? driveId,
    name: over.name ?? `env-${id.slice(0, 8)}`,
    createdBy: envCreatorId,
    sandboxId: over.sandboxId === undefined ? `sprite-${id.slice(0, 8)}` : over.sandboxId,
    spriteInstanceId: over.spriteInstanceId ?? null,
    spriteTornDownAt: over.spriteTornDownAt ?? null,
    storageLastBilledAt: over.storageLastBilledAt ?? ONE_MAX_SPAN_AGO,
    // 1 GB, measured just before `now` — a fresh measurement, so nothing here
    // is billed off a stale reading unless a test asks for it.
    storageMeasuredBytes: over.storageMeasuredBytes === undefined ? 1_000_000_000 : over.storageMeasuredBytes,
    storageMeasuredAt: over.storageMeasuredAt === undefined ? new Date(NOW.getTime() - 60_000) : over.storageMeasuredAt,
    updatedAt: new Date(),
  });
  return id;
}

async function readBilledAt(envId: string): Promise<Date | undefined> {
  const [row] = await db
    .select({ storageLastBilledAt: driveEnvs.storageLastBilledAt })
    .from(driveEnvs)
    .where(eq(driveEnvs.id, envId));
  return row?.storageLastBilledAt;
}

async function seedDrive(): Promise<void> {
  await db
    .insert(drives)
    .values({ id: driveId, name: 'Env Billing Drive', slug: `env-bill-${driveId}`, ownerId: driveOwnerId, updatedAt: new Date() })
    .onConflictDoNothing();
}

/** Set only when the operator explicitly opted out of DB suites AND Postgres is genuinely absent. */
let dbAvailable = true;

beforeAll(async () => {
  try {
    await db.execute(sql`SELECT 1`);
  } catch (error) {
    // Throws unless `ALLOW_SKIP_DB_TESTS=1`. There is no self-declared "the
    // database was optional" path: a missing Postgres is an environment failure
    // and is reported as one.
    requireDb('sandbox-storage-billing.integration.test.ts', error);
    dbAvailable = false;
    return;
  }
  await db
    .insert(users)
    .values([
      { id: driveOwnerId, email: `env-bill-owner-${driveOwnerId}@test.local`, name: 'Drive Owner', updatedAt: new Date() },
      { id: envCreatorId, email: `env-bill-creator-${envCreatorId}@test.local`, name: 'Env Creator', updatedAt: new Date() },
    ])
    .onConflictDoNothing();
  await seedDrive();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await db.delete(driveEnvs).where(eq(driveEnvs.driveId, driveId));
  // Re-seeded per test, not once: the skip case below DELETES the drive to
  // reproduce a mid-delete read, and a failing assertion there must not cascade
  // into every test after it.
  await seedDrive();
});

afterAll(async () => {
  if (!dbAvailable) return;
  await db.delete(driveEnvs).where(eq(driveEnvs.driveId, driveId));
  await db.delete(drives).where(eq(drives.id, driveId));
  await db.delete(users).where(inArray(users.id, [driveOwnerId, envCreatorId]));
});

// `skipIf` only ever fires under the explicit opt-out above — never on CI, and
// never as a suite's own decision that the database did not matter.
describe.skipIf(dbSkipExplicitlyAllowed())('environment persistence billing — real table, real attribution', () => {
  it('bills a live env to its DRIVE OWNER (never its creator) and advances THAT ROW\'s watermark', async () => {
    const envId = await seedEnv();
    const { deps, charges } = realDepsCapturingCharges();

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'a live env with a measured 1GB footprint, created by somebody who is not the drive owner',
      should: "charge the DRIVE's owner for one GB-month, attributed to the env's drive and to the env itself",
      actual: {
        charged: result.charged,
        payerId: charges[0]?.payerId,
        driveId: charges[0]?.driveId,
        subjectKind: charges[0]?.subjectKind,
        subjectId: charges[0]?.subjectId,
        gbMonths: Number(charges[0]?.gbMonths.toFixed(6)),
      },
      expected: {
        charged: 1,
        payerId: driveOwnerId,
        driveId,
        subjectKind: 'env',
        subjectId: envId,
        gbMonths: Number(ONE_DAY_OF_GB_MONTH.toFixed(6)),
      },
    });
    // `createdBy` is audit only: it must not be reachable as a payer.
    expect(charges.map((charge) => charge.payerId)).not.toContain(envCreatorId);
    // The window is closed in the table, so the next run bills from here.
    expect(await readBilledAt(envId)).toEqual(NOW);
  });

  it('enumerates ONLY envs that still believe they hold a live Sprite', async () => {
    const live = await seedEnv({ name: 'live' });
    await seedEnv({ name: 'never-provisioned', sandboxId: null });
    await seedEnv({ name: 'torn-down', spriteTornDownAt: new Date(NOW.getTime() - 1000) });
    const { deps, charges } = realDepsCapturingCharges();

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'a live env alongside a never-provisioned one and a torn-down one',
      should: 'meter only the live env — the other two hold no filesystem to bill',
      actual: { processed: result.processed, subjects: charges.map((charge) => charge.subjectId) },
      expected: { processed: 1, subjects: [live] },
    });
  });

  it('SKIPS an env whose drive vanished between the listing and the payer lookup — no charge, watermark untouched', async () => {
    const envId = await seedEnv();
    // The stale read the skip rule exists for, reproduced exactly: the row source
    // ran first (real SQL, real row), and the drive is gone by the time the payer
    // is resolved — at which point `drives.ownerId` is genuinely unknowable.
    const snapshot = (await defaultReconcileSandboxStorageDeps.listDriveEnvSprites()).filter(
      (row) => row.driveId === driveId,
    );
    await db.delete(drives).where(eq(drives.id, driveId));
    const { deps, charges } = realDepsCapturingCharges({ listDriveEnvSprites: async () => snapshot });

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'an env row read just before its drive was deleted',
      should: 'skip the cycle rather than bill anybody — no fallback payer exists for an env',
      actual: { skipped: result.skipped, charged: result.charged, charges: charges.length },
      expected: { skipped: 1, charged: 0, charges: 0 },
    });
    // The env row cascaded away with its drive; what matters is that nothing was
    // billed for it, and the snapshot proves the row source really did see it.
    expect(snapshot.map((row) => row.envId)).toContain(envId);
  });

  it('advances a never-measured env\'s watermark without charging it — the 0 floor, never a provisioned cap', async () => {
    const envId = await seedEnv({ storageMeasuredBytes: null, storageMeasuredAt: null });
    const { deps, charges } = realDepsCapturingCharges();

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'a live env that has never been measured',
      should: 'charge nothing but still close the window, so the unmeasured span is never billed retroactively',
      actual: { charged: result.charged, charges: charges.length, billedAt: await readBilledAt(envId) },
      expected: { charged: 0, charges: 0, billedAt: NOW },
    });
  });

  it('is a no-op on an immediate rerun — the advanced watermark leaves zero elapsed time to bill', async () => {
    await seedEnv();
    const first = realDepsCapturingCharges();
    await reconcileSandboxStorage(first.deps);

    const second = realDepsCapturingCharges();
    const result = await reconcileSandboxStorage(second.deps);

    assert({
      given: 'a second reconcile run at the same instant as the first',
      should: 'charge nothing — the watermark the first run wrote is what makes the meter idempotent',
      actual: { firstCharges: first.charges.length, secondCharges: second.charges.length, charged: result.charged },
      expected: { firstCharges: 1, secondCharges: 0, charged: 0 },
    });
  });
});

/**
 * The measurement WRITER's compare-and-swap, in real SQL.
 *
 * The seam's own suite proves it warns when the store says `false`; this proves
 * the store actually SAYS false when it should. Both halves are needed: an env
 * has one measurement writer, so a CAS that silently reported success would
 * leave the row NULL, billing the 0 floor, with the warning that exists to catch
 * exactly that never firing.
 *
 * Real Postgres because `eqOrIsNull` is the point — `eq` never matches NULL in
 * SQL, and an in-memory fake agrees with whichever semantics it was written to
 * model rather than with the database.
 */
describe.skipIf(dbSkipExplicitlyAllowed())('recordStorageMeasurement — the CAS, in SQL', () => {
  let store: DriveEnvStore;

  beforeAll(async () => {
    if (!dbAvailable) return;
    store = await createDbDriveEnvStore();
  });

  async function readMeasurement(envId: string) {
    const [row] = await db
      .select({ bytes: driveEnvs.storageMeasuredBytes, at: driveEnvs.storageMeasuredAt })
      .from(driveEnvs)
      .where(eq(driveEnvs.id, envId));
    return row;
  }

  it('WRITES and reports true when the measured generation matches the row', async () => {
    const envId = await seedEnv({ spriteInstanceId: 'gen-1', storageMeasuredBytes: null, storageMeasuredAt: null });

    const wrote = await store.recordStorageMeasurement({
      envId,
      spriteInstanceId: 'gen-1',
      measuredBytes: 3_000_000_000,
      measuredAt: NOW,
    });

    assert({
      given: 'a measurement taken on the generation the row currently points at',
      should: 'persist it and report the write',
      actual: { wrote, bytes: (await readMeasurement(envId))?.bytes },
      expected: { wrote: true, bytes: 3_000_000_000 },
    });
  });

  it('REFUSES, reporting false, when the generation moved while the du ran', async () => {
    const envId = await seedEnv({ spriteInstanceId: 'gen-2', storageMeasuredBytes: null, storageMeasuredAt: null });

    const wrote = await store.recordStorageMeasurement({
      envId,
      // The `du` ran on the PREVIOUS generation — its bytes describe a disk this
      // row no longer points at.
      spriteInstanceId: 'gen-1',
      measuredBytes: 3_000_000_000,
      measuredAt: NOW,
    });

    assert({
      given: "a measurement from a generation the row has since replaced",
      should: 'refuse the write and SAY so, so the caller can name an env left without a baseline',
      actual: { wrote, bytes: (await readMeasurement(envId))?.bytes },
      expected: { wrote: false, bytes: null },
    });
  });

  it('REFUSES, reporting false, on a torn-down row', async () => {
    const envId = await seedEnv({
      spriteInstanceId: 'gen-1',
      spriteTornDownAt: new Date(NOW.getTime() - 1000),
      storageMeasuredBytes: null,
      storageMeasuredAt: null,
    });

    const wrote = await store.recordStorageMeasurement({
      envId,
      spriteInstanceId: 'gen-1',
      measuredBytes: 3_000_000_000,
      measuredAt: NOW,
    });

    expect({ wrote, bytes: (await readMeasurement(envId))?.bytes }).toEqual({ wrote: false, bytes: null });
  });

  it('matches a NULL instance against a NULL row — `eq` never would', async () => {
    const envId = await seedEnv({ spriteInstanceId: null, storageMeasuredBytes: null, storageMeasuredAt: null });

    const wrote = await store.recordStorageMeasurement({
      envId,
      spriteInstanceId: null,
      measuredBytes: 1_000_000_000,
      measuredAt: NOW,
    });

    assert({
      given: 'a driver that reported no instance id, against a row that has none',
      should: 'still persist — `eqOrIsNull` is what stops a null-instance sandbox from never being measured',
      actual: { wrote, bytes: (await readMeasurement(envId))?.bytes },
      expected: { wrote: true, bytes: 1_000_000_000 },
    });
  });

});

/**
 * The retroactive-OVER-bill guard, in real SQL.
 *
 * Every other failure in this meter under-bills; this is the one shape that
 * could over-bill a real payer, so it is pinned against the database rather than
 * argued from a docblock. A torn-down env leaves the live listing
 * (`spriteTornDownAt IS NOT NULL`), so its watermark stops advancing and can sit
 * frozen indefinitely — and because Sprite names are deterministic, provisioning
 * again resumes the SAME filesystem, so the baseline `du` immediately records a
 * real footprint. The reset in `revivedDriveEnvColumns` is what stands between
 * those two facts and a bill for weeks in which no machine existed.
 */
describe.skipIf(dbSkipExplicitlyAllowed())('the billing watermark across dormancy', () => {
  let store: DriveEnvStore;

  beforeAll(async () => {
    if (!dbAvailable) return;
    store = await createDbDriveEnvStore();
  });
  it('RESETS the billing watermark when a torn-down env is provisioned again — the retroactive-over-bill guard', async () => {
    // The scenario worth pinning, because it is the one way the meter could
    // over-bill rather than under-bill. A torn-down env leaves the live listing
    // (`spriteTornDownAt IS NOT NULL`), so its watermark stops advancing and can
    // sit frozen for weeks. Sprite names are deterministic, so provisioning
    // again resumes the SAME filesystem and the baseline `du` immediately
    // records its real footprint. If the watermark were still the pre-teardown
    // one, the next tick would multiply that footprint by the entire dormant
    // span and charge a real payer for weeks in which no machine existed.
    const longAgo = new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000);
    const envId = await seedEnv({
      sandboxId: 'pgs-env-dormant',
      spriteInstanceId: 'gen-old',
      spriteTornDownAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000),
      storageLastBilledAt: longAgo,
    });

    // Provisioning again is the `create` arm (the row reads as torn down), which
    // goes through the identity write.
    const wrote = await store.updateSpriteIdentity({
      envId,
      previousSandboxId: 'pgs-env-dormant',
      spriteKey: 'env-key',
      sandboxId: 'pgs-env-dormant',
      spriteInstanceId: 'gen-new',
      egressPolicyToken: null,
      stamps: { lastActiveAt: NOW, teardownRequestedAt: null, spriteTornDownAt: null },
      now: NOW,
    });

    assert({
      given: 'a torn-down env, dormant for 40 days, being provisioned again',
      should: "reset its billing watermark to now, so the dormant span can never be billed retroactively",
      // `updateSpriteIdentity` reports its identity CAS (a boolean), not a
      // watermark verdict — the watermark is one column of that same write.
      actual: { wrote, billedAt: await readBilledAt(envId) },
      expected: { wrote: true, billedAt: NOW },
    });
  });

  it('bills a revived env only from its RESET watermark, not from before its dormancy', async () => {
    // The same guarantee, end to end through the real reconcile: revive, measure,
    // then meter. A frozen watermark would price 40 days of a 1GB footprint;
    // a reset one prices nothing, because no time has passed since the revive.
    const envId = await seedEnv({
      sandboxId: 'pgs-env-dormant-2',
      spriteInstanceId: 'gen-old',
      spriteTornDownAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000),
      storageLastBilledAt: new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000),
    });
    await store.updateSpriteIdentity({
      envId,
      previousSandboxId: 'pgs-env-dormant-2',
      spriteKey: 'env-key',
      sandboxId: 'pgs-env-dormant-2',
      spriteInstanceId: 'gen-new',
      egressPolicyToken: null,
      stamps: { lastActiveAt: NOW, teardownRequestedAt: null, spriteTornDownAt: null },
      now: NOW,
    });
    // The baseline the create arm's seam would have taken, on the resumed disk.
    await store.recordStorageMeasurement({
      envId,
      spriteInstanceId: 'gen-new',
      measuredBytes: 1_000_000_000,
      measuredAt: NOW,
    });

    const { deps, charges } = realDepsCapturingCharges();
    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'an env revived from 40 days of dormancy, then metered',
      should: 'charge NOTHING for the dormant span — zero elapsed since the revive reset its watermark',
      actual: { charged: result.charged, processed: result.processed, charges: charges.length },
      expected: { charged: 0, processed: 1, charges: 0 },
    });
  });


  it('REFUSES to move a watermark BACKWARDS — a provision that landed mid-tick must win', async () => {
    // The race, concretely. A tick captures ONE `now` and then makes several
    // awaits per row, so it can span minutes. If a user rebuilds an env inside
    // that window, `revivedDriveEnvColumns` resets the row's watermark FORWARD to
    // the provision time — correct, because a new Sprite generation is a fresh
    // disk. An unguarded advance would then drag it BACK to the tick's `now`, and
    // the span between the two would be billed a second time on the next tick.
    const envId = await seedEnv({ storageLastBilledAt: NOW });
    // The mid-tick provision: watermark reset to 30s AFTER the tick's `now`.
    const resetTo = new Date(NOW.getTime() + 30_000);
    await db.update(driveEnvs).set({ storageLastBilledAt: resetTo }).where(eq(driveEnvs.id, envId));

    // The tick's advance, arriving late and carrying the older timestamp.
    const wrote = await defaultReconcileSandboxStorageDeps.advanceDriveEnvWatermark({ envId, billedThrough: NOW });

    assert({
      given: 'a watermark already reset forward by a provision that landed during the tick',
      should:
        'leave the newer value alone AND report the refusal — moving it back would re-bill the span, and declining invisibly would hide that a generation boundary cut a window',
      actual: { wrote, billedAt: await readBilledAt(envId) },
      expected: { wrote: 'superseded', billedAt: resetTo },
    });
  });

  it('still advances a watermark FORWARD in the ordinary case', async () => {
    const envId = await seedEnv({ storageLastBilledAt: new Date(NOW.getTime() - 60_000) });

    const wrote = await defaultReconcileSandboxStorageDeps.advanceDriveEnvWatermark({ envId, billedThrough: NOW });

    assert({
      given: 'a watermark older than the tick that is closing it',
      should: 'advance normally and report the write — the guard must refuse only backwards writes',
      actual: { wrote, billedAt: await readBilledAt(envId) },
      expected: { wrote: 'advanced', billedAt: NOW },
    });
  });

  it('applies the SAME monotonic guard to the session watermark', async () => {
    // The session twin has the identical race — a re-provision resets its
    // watermark the same way — so it gets the identical guard. The two row
    // sources share a meter; they must not disagree about how a watermark moves.
    const sessionId = createId();
    await db.insert(agentWorkspaces).values({
      id: sessionId,
      driveId,
      ownerId: driveOwnerId,
      storageLastBilledAt: new Date(NOW.getTime() + 30_000),
      updatedAt: new Date(),
    });

    const wrote = await defaultReconcileSandboxStorageDeps.advanceAgentSessionWatermark({
      workspaceId: sessionId,
      billedThrough: NOW,
    });
    expect(wrote).toBe('superseded');

    const [row] = await db
      .select({ at: agentWorkspaces.storageLastBilledAt })
      .from(agentWorkspaces)
      .where(eq(agentWorkspaces.id, sessionId));
    expect(row?.at).toEqual(new Date(NOW.getTime() + 30_000));

    await db.delete(agentWorkspaces).where(eq(agentWorkspaces.id, sessionId));
  });


  it('REFUSES to let a PROVISION drag the watermark backwards either — the guard is two-sided', async () => {
    // The second double-bill path, and the subtler one. `ensureSpriteHolderSandbox`
    // captures its `now` BEFORE the provider IO, so the timestamp a provision
    // writes can be tens of seconds stale by the time the write lands. If a
    // reconcile tick charged through a LATER instant in that gap, a plain
    // assignment would drag the watermark back past what was just billed and the
    // next tick would re-bill the difference. `GREATEST` on the provision side
    // closes it — the guard has to be on BOTH writers, not just the reconcile's.
    const provisionCapturedAt = new Date(NOW.getTime() - 45_000);
    // `sandboxId: null` so the identity CAS (`previousSandboxId: null`) MATCHES —
    // otherwise the whole write is refused and this test would pass without ever
    // exercising the watermark column.
    const envId = await seedEnv({ sandboxId: null, spriteTornDownAt: new Date(NOW.getTime() - 60_000) });
    // The tick got there first and billed through NOW.
    await db.update(driveEnvs).set({ storageLastBilledAt: NOW }).where(eq(driveEnvs.id, envId));

    // The provision's write lands late, carrying its stale pre-IO timestamp.
    await store.updateSpriteIdentity({
      envId,
      previousSandboxId: null,
      spriteKey: 'env-key',
      sandboxId: 'pgs-env-late',
      spriteInstanceId: 'gen-new',
      egressPolicyToken: null,
      stamps: { lastActiveAt: NOW, teardownRequestedAt: null, spriteTornDownAt: null },
      now: provisionCapturedAt,
    });
    // Proves the write LANDED — without this the test would also pass on a
    // refused identity CAS, which writes nothing at all.
    expect((await db.select({ id: driveEnvs.spriteInstanceId }).from(driveEnvs).where(eq(driveEnvs.id, envId)))[0]?.id)
      .toBe('gen-new');

    assert({
      given: 'a provision whose pre-IO timestamp is older than what a tick already billed through',
      should: 'keep the billed-through value — assigning the stale one would re-bill the gap next tick',
      actual: await readBilledAt(envId),
      expected: NOW,
    });
  });

  it('still lets a provision push the watermark FORWARD, which is the reset\'s whole purpose', async () => {
    const envId = await seedEnv({
      sandboxId: null,
      storageLastBilledAt: new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000),
    });

    await store.updateSpriteIdentity({
      envId,
      previousSandboxId: null,
      spriteKey: 'env-key',
      sandboxId: 'pgs-env-fwd',
      spriteInstanceId: 'gen-new',
      egressPolicyToken: null,
      stamps: { lastActiveAt: NOW, teardownRequestedAt: null, spriteTornDownAt: null },
      now: NOW,
    });

    assert({
      given: 'a provision on a row whose watermark is older than the provision',
      should: 'advance it — a new generation must not inherit the dead one\'s window',
      actual: await readBilledAt(envId),
      expected: NOW,
    });
  });

});

/**
 * SINGLE BILLING for one disk — the invariant the env/session split rests on.
 *
 * An env-bound session shares the ENV's filesystem and owns no Sprite of its
 * own. If such a row ever appeared in `listAgentSessionSprites` alongside the
 * env in `listDriveEnvSprites`, one disk would be metered twice, against the
 * same payer, every tick.
 *
 * Today that rests entirely on `agent_workspaces_env_no_sprite_check` — a CHECK
 * constraint forbidding an `envId` row from carrying Sprite pointers — plus the
 * row source's `sandboxId IS NOT NULL` predicate. Neither is asserted anywhere,
 * and "the schema makes it impossible" is exactly the kind of claim that stops
 * being true quietly. So it is pinned here, against the real table and the real
 * predicate.
 */
describe.skipIf(dbSkipExplicitlyAllowed())('single billing: an env-bound session is never its own row source', () => {
  it('is ABSENT from listAgentSessionSprites, so one filesystem is metered once', async () => {
    const envId = await seedEnv();
    const boundSessionId = createId();
    // The shape an env-bound session has by construction: `envId` set, and NO
    // Sprite pointers — the CHECK constraint refuses any other combination.
    await db.insert(agentWorkspaces).values({
      id: boundSessionId,
      driveId,
      ownerId: driveOwnerId,
      envId,
      updatedAt: new Date(),
    });

    const sessions = await defaultReconcileSandboxStorageDeps.listAgentSessionSprites();
    const envs = (await defaultReconcileSandboxStorageDeps.listDriveEnvSprites()).filter(
      (row) => row.driveId === driveId,
    );

    assert({
      given: 'a session bound to an env, sharing that env\'s filesystem',
      should: 'appear in NEITHER row source as a billable sandbox — only the env itself is metered',
      actual: {
        sessionListed: sessions.some((row) => row.workspaceId === boundSessionId),
        envListed: envs.some((row) => row.envId === envId),
      },
      expected: { sessionListed: false, envListed: true },
    });

    await db.delete(agentWorkspaces).where(eq(agentWorkspaces.id, boundSessionId));
  });

  it('is refused by the database if it ever tries to carry its own Sprite', async () => {
    // The structural half. If this CHECK were dropped, the row above could
    // acquire a `sandboxId`, enter `listAgentSessionSprites`, and double-bill
    // the env's disk — so the constraint is asserted rather than assumed.
    const envId = await seedEnv();

    await expect(
      db.insert(agentWorkspaces).values({
        id: createId(),
        driveId,
        ownerId: driveOwnerId,
        envId,
        sandboxId: 'pgs-should-be-refused',
        updatedAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});

/**
 * The billable-span CAP — the guard against a frozen watermark becoming a
 * retroactive over-bill.
 *
 * A `skipped` row keeps its watermark while its footprint grows. Without a cap,
 * the tick where the payer finally resolves prices the WHOLE frozen span at
 * TODAY's footprint — the same retroactive over-bill the `$0` branch refuses,
 * arriving by a different door. The excess is forgiven (an under-bill, the
 * accepted direction) and counted.
 */
describe.skipIf(dbSkipExplicitlyAllowed())('the billable-span cap', () => {
  it('bills at most ONE span for a watermark frozen far longer, and forgives the rest', async () => {
    // Forty days frozen, 1GB measured. Uncapped this would bill 40 days of 1GB
    // against a real payer for a period most of which held far less.
    const envId = await seedEnv({
      storageLastBilledAt: new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000),
    });
    const { deps, charges } = realDepsCapturingCharges();

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'an env whose watermark has been frozen for forty days',
      should: 'bill exactly one capped span, count the clamp, and advance the watermark so the excess is forgiven once',
      actual: {
        charged: result.charged,
        spanClamped: result.spanClamped,
        gbMonths: Number(charges[0]?.gbMonths.toFixed(6)),
        billedAt: await readBilledAt(envId),
      },
      expected: {
        charged: 1,
        spanClamped: 1,
        gbMonths: Number(ONE_DAY_OF_GB_MONTH.toFixed(6)),
        billedAt: NOW,
      },
    });
  });

  it('does NOT clamp — or count — an ordinary window inside the cap', async () => {
    await seedEnv({ storageLastBilledAt: new Date(NOW.getTime() - 60 * 60 * 1000) });
    const { deps, charges } = realDepsCapturingCharges();

    const result = await reconcileSandboxStorage(deps);

    assert({
      given: 'an hour-old watermark, well inside the cap',
      should: 'bill the real elapsed hour and report no clamp',
      actual: {
        spanClamped: result.spanClamped,
        gbMonths: Number(charges[0]?.gbMonths.toFixed(8)),
      },
      expected: {
        spanClamped: 0,
        gbMonths: Number((60 * 60 * 1000 / MS_PER_STORAGE_MONTH).toFixed(8)),
      },
    });
  });
});

/**
 * The watermark round-trip is UTC-SYMMETRIC, whatever the process timezone.
 *
 * `classifyWatermarkWrite` decides `advanced` vs `superseded` by comparing the
 * `Date` that `RETURNING` gave back against the one we asked to write. That is
 * only sound if the round-trip preserves the instant — and `storageLastBilledAt`
 * is `timestamp` WITHOUT time zone, whose raw node-pg parser resolves through the
 * PROCESS timezone (verified: `getTypeParser(1114)('2026-08-19 10:00:00')` yields
 * `15:00Z` on an America/Chicago box). If that parser were in play, every
 * ordinary advance west of UTC would misreport as `superseded`.
 *
 * It is not in play, because drizzle maps the COLUMN rather than trusting the
 * driver: `PgTimestamp.mapToDriverValue` writes `toISOString()`, and
 * `mapFromDriverValue` appends `+0000` for a non-tz column. Both ends are pinned
 * to UTC by construction.
 *
 * That is a fact about a dependency, and dependencies change — so it is asserted
 * here rather than trusted. A drizzle bump that altered either mapper would
 * otherwise surface as billing counters quietly going wrong on non-UTC
 * deployments, which is exactly the class of bug this file exists to catch.
 */
describe.skipIf(dbSkipExplicitlyAllowed())('watermark round-trip is timezone-independent', () => {
  it('returns the same instant it was given, and classifies it as advanced', async () => {
    const envId = await seedEnv({ storageLastBilledAt: new Date(NOW.getTime() - 60 * 60 * 1000) });

    const outcome = await defaultReconcileSandboxStorageDeps.advanceDriveEnvWatermark({
      envId,
      billedThrough: NOW,
    });

    assert({
      given: `a watermark advance on a box running in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
      should: 'read back the exact instant written and report `advanced`, not a timezone-shifted `superseded`',
      actual: { outcome, billedAt: await readBilledAt(envId) },
      expected: { outcome: 'advanced', billedAt: NOW },
    });
  });

  it('still distinguishes a genuinely superseded watermark, not merely a shifted one', async () => {
    // The other half: if the round-trip were offset, a real supersede smaller
    // than the offset would read as `advanced`. This one is a minute ahead —
    // far smaller than any UTC offset — so only an exact round-trip detects it.
    const envId = await seedEnv({ storageLastBilledAt: new Date(NOW.getTime() + 60_000) });

    const outcome = await defaultReconcileSandboxStorageDeps.advanceDriveEnvWatermark({
      envId,
      billedThrough: NOW,
    });

    expect(outcome).toBe('superseded');
  });
});

