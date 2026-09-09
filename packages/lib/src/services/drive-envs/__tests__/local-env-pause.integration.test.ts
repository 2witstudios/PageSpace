/**
 * Stop / Resume — the `setPaused` compare-and-set on REAL Postgres (GA wave
 * 3, leaf 3). The claim is the store's: ONE `UPDATE … WHERE envId AND ownerId
 * AND revokedAt IS NULL`, so a non-owner (a drive admin included, [D-6]) and a
 * revoked row lose the predicate and are left byte-identical. A fake compares
 * with `===`; SQL needs `IS NULL`, and only the database can say which it
 * emitted. The session runs in a NON-UTC timezone locally (America/Chicago)
 * so a `pausedAt` that took the column default instead of the caller's clock
 * would land offset and fail the equality below.
 *
 * Runs in CI: ci.yml's unit and test:integration steps (this file is not
 * excluded from the default config) and the NAMED security.yml `test:db`
 * step. Locally:
 *     PGTZ=America/Chicago DATABASE_URL=... bun run --filter '@pagespace/lib' test -- src/services/drive-envs/__tests__/local-env-pause.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { driveEnvLocal } from '@pagespace/db/schema/drive-env-local';
import { createDbDriveEnvStore, type DriveEnvStore } from '../drive-envs-store';

const ownerId = createId();
const adminId = createId();
const driveId = createId();
const NOW = new Date('2026-09-09T12:00:00.000Z');
const LATER = new Date('2026-09-09T12:05:00.000Z');

let store: DriveEnvStore;
let envId: string;

async function seed(over: { revokedAt?: Date | null } = {}): Promise<string> {
  const id = createId();
  await db.insert(driveEnvs).values({ id, driveId, name: `mac-${id.slice(0, 6)}`, substrate: 'local', createdBy: ownerId, updatedAt: NOW });
  await db.insert(driveEnvLocal).values({ envId: id, ownerId, label: 'mac', enrollmentId: `enr_${id}`, serverPolicy: { ops: ['exec'], checkpoint: false }, revokedAt: over.revokedAt ?? null, updatedAt: NOW });
  return id;
}

const readRow = async (id: string) => (await db.select().from(driveEnvLocal).where(eq(driveEnvLocal.envId, id)))[0]!;

beforeAll(async () => {
  store = await createDbDriveEnvStore();
  await db.insert(users).values([
    { id: ownerId, email: `pause-owner-${ownerId}@test.local`, name: 'Owner', updatedAt: NOW },
    { id: adminId, email: `pause-admin-${adminId}@test.local`, name: 'Admin', updatedAt: NOW },
  ]).onConflictDoNothing();
  await db.insert(drives).values({ id: driveId, name: 'Pause Drive', slug: `pause-drive-${driveId}`, ownerId: adminId, updatedAt: NOW }).onConflictDoNothing();
});

beforeEach(async () => {
  await db.delete(driveEnvs).where(eq(driveEnvs.driveId, driveId));
  envId = await seed();
});

afterAll(async () => {
  await db.delete(driveEnvs).where(eq(driveEnvs.driveId, driveId));
  await db.delete(drives).where(eq(drives.id, driveId));
  await db.delete(users).where(eq(users.id, ownerId));
  await db.delete(users).where(eq(users.id, adminId));
});

describe('setPaused — the CAS on (envId, ownerId, revokedAt IS NULL)', () => {
  it('given the OWNER, Stop stamps pausedAt with the CALLER\'s clock (never the column default) and Resume clears it; key and policy untouched', async () => {
    expect(await store.setPaused({ envId, ownerId, paused: true, now: LATER })).toBe(true);
    let row = await readRow(envId);
    expect(row.pausedAt?.getTime()).toBe(LATER.getTime());
    expect(row.revokedAt).toBeNull();
    expect(row.serverPolicy).toEqual({ ops: ['exec'], checkpoint: false });
    expect(await store.setPaused({ envId, ownerId, paused: false, now: LATER })).toBe(true);
    row = await readRow(envId);
    expect(row.pausedAt).toBeNull();
  });

  it('given a NON-owner (the drive admin who owns the drive), the CAS loses on Stop AND on Resume and the row is byte-identical', async () => {
    let before = await readRow(envId);
    expect(await store.setPaused({ envId, ownerId: adminId, paused: true, now: LATER })).toBe(false);
    expect(await readRow(envId)).toEqual(before);
    // Nor may an admin RESUME what the owner stopped.
    expect(await store.setPaused({ envId, ownerId, paused: true, now: LATER })).toBe(true);
    before = await readRow(envId);
    expect(await store.setPaused({ envId, ownerId: adminId, paused: false, now: new Date(LATER.getTime() + 1000) })).toBe(false);
    expect(await readRow(envId)).toEqual(before);
  });

  it('given a REVOKED row, the owner\'s Stop loses too — revocation is terminal', async () => {
    const revoked = await seed({ revokedAt: NOW });
    const before = await readRow(revoked);
    expect(await store.setPaused({ envId: revoked, ownerId, paused: true, now: LATER })).toBe(false);
    expect(await readRow(revoked)).toEqual(before);
  });

  it('given a missing env, answers false', async () => {
    expect(await store.setPaused({ envId: 'env_missing', ownerId, paused: true, now: LATER })).toBe(false);
  });

  it('Stop twice keeps the FIRST pausedAt (the predicate excludes an already-paused row from re-stamping)', async () => {
    expect(await store.setPaused({ envId, ownerId, paused: true, now: LATER })).toBe(true);
    expect(await store.setPaused({ envId, ownerId, paused: true, now: new Date(LATER.getTime() + 60_000) })).toBe(true);
    expect((await readRow(envId)).pausedAt?.getTime()).toBe(LATER.getTime());
  });

  it('findLocalByEnvId carries pausedAt — what decideSign\'s caller reads', async () => {
    await store.setPaused({ envId, ownerId, paused: true, now: LATER });
    expect((await store.findLocalByEnvId(envId))?.pausedAt?.getTime()).toBe(LATER.getTime());
  });
});
