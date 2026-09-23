/**
 * Storage attribution to org drives — REAL Postgres (Spec WAL-9, O-9; D-OW-9).
 *
 * The pure rules are unit-tested in storage-attribution.test.ts. This file proves what only the
 * database can: an upload into an org drive leaves the uploader's personal counter alone and is
 * checked against the org's derived usage; a move in or out re-attributes byte counts exactly,
 * atomically with drives.orgId, with nothing double-counted or orphaned; and the reconcile's
 * basis agrees, so the cron never "corrects" an org drive's bytes back onto a person.
 *
 * Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test:integration -- src/services/__tests__/storage-attribution.integration.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray, or } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, storageEvents } from '@pagespace/db/schema/core';
import { files } from '@pagespace/db/schema/storage';
import { organizations, orgMembers, type OrgRole } from '@pagespace/db/schema/organizations';
import { moveDriveToOrg, moveDriveOutOfOrg, type OrgDriveServiceDeps } from '../org-drive-service';
import {
  calculateActualStorageUsage,
  chargeStorageForStore,
  checkStorageQuotaForDrive,
  getOrgStorageQuota,
  getStorageQuotaForDrive,
  STORAGE_TIERS,
} from '../storage-limits';
import { storageRepository } from '../storage-repository';

// Northwind Labs fixture names (Sequence Spec Part 2), with per-run ids.
const run = createId().slice(0, 8);
const jono = createId();
const marcus = createId();
const lena = createId();
const northwind = createId();
const userIds = [jono, marcus, lena];

const deps: OrgDriveServiceDeps = {
  getOrgRole: async (tx, orgId, userId) => {
    const [row] = await tx
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
    return (row?.role ?? null) as OrgRole | null;
  },
  syncOrgMembership: async () => async () => {},
  getOrgDriveCreationPolicy: async () => 'members',
};

/** Old enough that the reconcile's upload cooldown never hides these rows. */
const settled = () => new Date(Date.now() - 60 * 60 * 1000);

async function seedDrive(ownerId: string, orgId: string | null = null) {
  const id = createId();
  await db.insert(drives).values({
    id,
    name: 'Product',
    slug: `product-${run}-${id.slice(0, 6)}`,
    ownerId,
    orgId,
    publishSubdomain: `product-${id}`,
    updatedAt: new Date(),
  });
  return id;
}

async function seedFile(driveId: string | null, createdBy: string, sizeBytes: number) {
  const id = createId();
  await db.insert(files).values({ id, driveId, createdBy, sizeBytes, storagePath: id, createdAt: settled() });
  return id;
}

async function setCounter(userId: string, bytes: number) {
  await db.update(users).set({ storageUsedBytes: bytes }).where(eq(users.id, userId));
}

async function counter(userId: string): Promise<number> {
  const [row] = await db.select({ used: users.storageUsedBytes }).from(users).where(eq(users.id, userId));
  return Math.round(row?.used ?? 0);
}

/**
 * CI shares one database across suites: delete every row this file creates, children first,
 * users last. files and storage_events cascade with their drive and user, but are deleted
 * explicitly so a failed assertion cannot strand them.
 */
async function cleanup() {
  const runDrives = await db
    .select({ id: drives.id })
    .from(drives)
    .where(or(eq(drives.orgId, northwind), inArray(drives.ownerId, userIds)));
  const driveIds = runDrives.map((d) => d.id);
  await db.delete(files).where(inArray(files.createdBy, userIds));
  if (driveIds.length > 0) {
    await db.delete(files).where(inArray(files.driveId, driveIds));
    await db.delete(drives).where(inArray(drives.id, driveIds));
  }
  await db.delete(storageEvents).where(inArray(storageEvents.userId, userIds));
  await db.delete(orgMembers).where(eq(orgMembers.orgId, northwind));
  await db.delete(organizations).where(eq(organizations.id, northwind));
  await db.delete(users).where(inArray(users.id, userIds));
}

beforeEach(async () => {
  await cleanup();
  await db.insert(users).values([
    { id: jono, email: `jono-${run}@northwind.test`, name: 'Jono', updatedAt: new Date() },
    { id: marcus, email: `marcus-${run}@northwind.test`, name: 'Marcus Oyelaran', updatedAt: new Date() },
    { id: lena, email: `lena-${run}@northwind.test`, name: 'Lena Schulz', updatedAt: new Date() },
  ]);
  await db.insert(organizations).values({ id: northwind, name: 'Northwind Labs', slug: `northwind-${run}`, ownerId: jono });
  await db.insert(orgMembers).values([
    { orgId: northwind, userId: jono, role: 'OWNER' },
    { orgId: northwind, userId: marcus, role: 'MEMBER' },
    { orgId: northwind, userId: lena, role: 'MEMBER' },
  ]);
});

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe('uploads into an org drive', () => {
  it('WAL-9 (partial) the first store in an org drive bills the org and leaves the uploader\'s counter untouched', async () => {
    const orgDrive = await seedDrive(marcus, northwind);
    await setCounter(lena, 700);
    await seedFile(orgDrive, lena, 1000);

    const payer = await chargeStorageForStore(lena, orgDrive, 1000, { eventType: 'upload' });

    expect(payer).toEqual({ kind: 'org', orgId: northwind });
    expect(await counter(lena)).toBe(700);
    const events = await db.select().from(storageEvents).where(eq(storageEvents.userId, lena));
    expect(events).toEqual([]);
    expect((await getOrgStorageQuota(northwind)).usedBytes).toBe(1000);
  });

  it('WAL-9 (partial) a store in a personal drive still charges the uploader (control)', async () => {
    const personal = await seedDrive(lena);
    await setCounter(lena, 700);

    const payer = await chargeStorageForStore(lena, personal, 300, { eventType: 'upload' });

    expect(payer).toEqual({ kind: 'user', userId: lena });
    expect(await counter(lena)).toBe(1000);
  });

  it('WAL-9 (partial) an uploader whose personal quota is full can still upload into an org drive, and not into their own', async () => {
    const orgDrive = await seedDrive(marcus, northwind);
    const personal = await seedDrive(lena);
    const freeQuota = STORAGE_TIERS.free.quotaBytes;
    await setCounter(lena, freeQuota);

    const intoOrg = await checkStorageQuotaForDrive(lena, orgDrive, 1024);
    const intoOwn = await checkStorageQuotaForDrive(lena, personal, 1024);

    expect(intoOrg.allowed).toBe(true);
    expect(intoOrg.quota).toMatchObject({ orgId: northwind, tier: 'business' });
    expect(intoOwn.allowed).toBe(false);
    expect(await getStorageQuotaForDrive(lena, orgDrive)).toMatchObject({ orgId: northwind });
  });

  it('WAL-9 (partial) the org\'s usage is derived from every drive it owns, and nothing else', async () => {
    const orgA = await seedDrive(marcus, northwind);
    const orgB = await seedDrive(lena, northwind);
    const personal = await seedDrive(lena);
    await seedFile(orgA, marcus, 100);
    await seedFile(orgB, lena, 20);
    await seedFile(personal, lena, 5000);

    expect((await getOrgStorageQuota(northwind)).usedBytes).toBe(120);
  });
});

describe('moving a drive re-attributes its bytes', () => {
  it('WAL-9 (partial) move in takes exactly each uploader\'s bytes off their counter and onto the org; move out puts exactly them back', async () => {
    const product = await seedDrive(marcus);
    const marcusOther = await seedDrive(marcus);
    await seedFile(product, marcus, 1000);
    await seedFile(product, lena, 250);
    await seedFile(marcusOther, marcus, 500);
    await setCounter(marcus, 1500);
    await setCounter(lena, 250);

    const movedIn = await moveDriveToOrg(marcus, product, { orgId: northwind }, deps);

    expect(movedIn).toMatchObject({ ok: true, storageReattribution: { status: 'applied', movedBytes: 1250 } });
    expect(await counter(marcus)).toBe(500);
    expect(await counter(lena)).toBe(0);
    expect((await getOrgStorageQuota(northwind)).usedBytes).toBe(1250);
    // Conservation: every byte is billed to exactly one party.
    expect((await counter(marcus)) + (await counter(lena)) + (await getOrgStorageQuota(northwind)).usedBytes).toBe(1750);

    const movedOut = await moveDriveOutOfOrg(jono, product, { implicitMembers: 'keep' }, deps);

    expect(movedOut).toMatchObject({ ok: true, storageReattribution: { status: 'applied', movedBytes: 1250 } });
    expect(await counter(marcus)).toBe(1500);
    expect(await counter(lena)).toBe(250);
    expect((await getOrgStorageQuota(northwind)).usedBytes).toBe(0);
  });

  it('WAL-9 (partial) each re-attribution is logged per uploader with the drive, org and direction', async () => {
    const product = await seedDrive(marcus);
    await seedFile(product, lena, 250);
    await setCounter(lena, 250);

    await moveDriveToOrg(marcus, product, { orgId: northwind }, deps);

    const events = await db.select().from(storageEvents).where(eq(storageEvents.userId, lena));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'reattribute',
      sizeDelta: -250,
      totalSizeAfter: 0,
      metadata: { driveId: product, orgId: northwind, direction: 'into-org' },
    });
  });

  it('WAL-9 (partial) a refused move re-attributes nothing', async () => {
    const product = await seedDrive(marcus);
    await seedFile(product, marcus, 1000);
    await setCounter(marcus, 1000);

    // Lena does not own the drive, so she cannot move it in.
    const refused = await moveDriveToOrg(lena, product, { orgId: northwind }, deps);

    expect(refused.ok).toBe(false);
    expect(await counter(marcus)).toBe(1000);
    expect((await getOrgStorageQuota(northwind)).usedBytes).toBe(0);
  });
});

describe('the reconcile agrees with the attribution', () => {
  it('WAL-9 (partial) an uploader\'s derived usage excludes their files in org drives, so the cron never bills them back', async () => {
    const orgDrive = await seedDrive(marcus, northwind);
    const personal = await seedDrive(lena);
    await seedFile(orgDrive, lena, 1000);
    await seedFile(personal, lena, 40);
    await seedFile(null, lena, 2); // a DM attachment: no drive, personal
    await setCounter(lena, 42);

    expect(await calculateActualStorageUsage(lena)).toBe(42);
    const candidates = await storageRepository.findStorageDriftCandidates(1, 0);
    expect(candidates.find((c) => c.userId === lena)).toBeUndefined();
  });
});
