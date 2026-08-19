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
 * Runs in CI (the Unit Tests job provides Postgres). Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test -- src/services/sandbox/__tests__/sandbox-storage-billing.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { assert } from './riteway';
import { defaultReconcileSandboxStorageDeps } from '../sandbox-storage-billing';
import {
  reconcileSandboxStorage,
  MS_PER_STORAGE_MONTH,
  type ReconcileSandboxStorageDeps,
} from '../sandbox-storage-reconcile';

const driveOwnerId = createId();
/** Deliberately NOT the drive owner — `drive_envs.createdBy` is audit only, and this id must never appear on a charge. */
const envCreatorId = createId();
const driveId = createId();

const NOW = new Date('2026-08-18T00:00:00.000Z');
/** One full storage-month before `NOW`, so a 1GB footprint prices to exactly 1 GB-month. */
const ONE_MONTH_AGO = new Date(NOW.getTime() - MS_PER_STORAGE_MONTH);

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
    storageLastBilledAt: over.storageLastBilledAt ?? ONE_MONTH_AGO,
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

beforeAll(async () => {
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
  await db.delete(driveEnvs).where(eq(driveEnvs.driveId, driveId));
  // Re-seeded per test, not once: the skip case below DELETES the drive to
  // reproduce a mid-delete read, and a failing assertion there must not cascade
  // into every test after it.
  await seedDrive();
});

afterAll(async () => {
  await db.delete(driveEnvs).where(eq(driveEnvs.driveId, driveId));
  await db.delete(drives).where(eq(drives.id, driveId));
  await db.delete(users).where(inArray(users.id, [driveOwnerId, envCreatorId]));
});

describe('environment persistence billing — real table, real attribution', () => {
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
        gbMonths: 1,
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
    const snapshot = await defaultReconcileSandboxStorageDeps.listDriveEnvSprites();
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
