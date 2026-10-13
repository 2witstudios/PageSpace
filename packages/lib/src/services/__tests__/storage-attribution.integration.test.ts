/**
 * Storage attribution to org drives — REAL Postgres (Spec WAL-9, O-9; D-OW-9).
 *
 * The pure rules are unit-tested in storage-attribution.test.ts. This file proves what only the
 * database can: an upload into an org drive leaves the uploader's personal counter alone and is
 * checked against the org's derived usage; an upload into a PERSONAL drive bills the drive's
 * owner, whoever uploads it (the payer seam "org if drives.orgId, else owner"); a move in or out,
 * or a hand-over to a new owner, re-attributes byte counts exactly, atomically with the drive
 * row, with nothing double-counted or orphaned; and the reconcile's basis agrees, so the cron
 * never "corrects" bytes back onto anyone else.
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
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { publishedApps } from '@pagespace/db/schema/published-apps';
import { publishedAppSubscriptions } from '@pagespace/db/schema/published-app-subscriptions';
import { appHostingStripeReclaims } from '@pagespace/db/schema/app-hosting-stripe-reclaims';
import { organizations, orgMembers, orgSubscriptions, type OrgRole } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { moveDriveToOrg, moveDriveOutOfOrg, type OrgDriveServiceDeps } from '../org-drive-service';
import {
  calculateActualStorageUsage,
  chargeStorageForStore,
  checkStorageQuotaForDrive,
  getOrgStorageQuota,
  reattributeDriveOwnerStorageInTx,
  resolveUploadQuotaTarget,
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
  await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, northwind));
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
  // Paid: there is no org trial, and an unpaid org is lapsed from creation (D-OW-30).
  await factories.createOrgSubscription(northwind);
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

  it('WAL-9 (partial) a store in your own personal drive charges you (control)', async () => {
    const personal = await seedDrive(lena);
    await setCounter(lena, 700);

    const payer = await chargeStorageForStore(lena, personal, 300, { eventType: 'upload' });

    expect(payer).toEqual({ kind: 'user', userId: lena });
    expect(await counter(lena)).toBe(1000);
  });

  it('WAL-9 (partial) a member\'s store in SOMEONE ELSE\'s personal drive charges the drive owner, is checked on the owner\'s quota, and leaves the uploader untouched', async () => {
    const marcusDrive = await seedDrive(marcus);
    await setCounter(marcus, 100);
    await setCounter(lena, 700);

    const target = await resolveUploadQuotaTarget(lena, marcusDrive);
    const payer = await chargeStorageForStore(lena, marcusDrive, 300, { eventType: 'upload' });

    expect(target?.payer).toEqual({ kind: 'user', userId: marcus });
    expect(target?.quota).toMatchObject({ userId: marcus });
    expect(payer).toEqual({ kind: 'user', userId: marcus });
    expect(await counter(marcus)).toBe(400);
    expect(await counter(lena)).toBe(700);
  });

  it('WAL-9 (partial) a drive-less attachment (a DM) charges its uploader', async () => {
    await setCounter(lena, 0);
    expect(await chargeStorageForStore(lena, null, 50, { eventType: 'upload' })).toEqual({ kind: 'user', userId: lena });
    expect(await counter(lena)).toBe(50);
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
    expect((await resolveUploadQuotaTarget(lena, orgDrive))?.quota).toMatchObject({ orgId: northwind });
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
  it('WAL-9 (partial) move in takes exactly the drive\'s bytes — every uploader\'s — off its OWNER\'s counter and onto the org; move out puts exactly them back on the owner', async () => {
    const product = await seedDrive(marcus);
    const marcusOther = await seedDrive(marcus);
    await seedFile(product, marcus, 1000);
    await seedFile(product, lena, 250);
    await seedFile(marcusOther, marcus, 500);
    // While personal, every byte in Marcus's drives bills Marcus, Lena's upload included.
    await setCounter(marcus, 1750);
    await setCounter(lena, 0);

    const movedIn = await moveDriveToOrg(marcus, product, { credential: 'session', orgId: northwind }, deps);

    expect(movedIn).toMatchObject({ ok: true, storageReattribution: { status: 'applied', movedBytes: 1250 } });
    expect(await counter(marcus)).toBe(500);
    expect(await counter(lena)).toBe(0);
    expect((await getOrgStorageQuota(northwind)).usedBytes).toBe(1250);
    // Conservation: every byte is billed to exactly one party.
    expect((await counter(marcus)) + (await counter(lena)) + (await getOrgStorageQuota(northwind)).usedBytes).toBe(1750);

    const movedOut = await moveDriveOutOfOrg(jono, product, { credential: 'session', implicitMembers: 'keep' }, deps);

    expect(movedOut).toMatchObject({ ok: true, storageReattribution: { status: 'applied', movedBytes: 1250 } });
    expect(await counter(marcus)).toBe(1750);
    expect(await counter(lena)).toBe(0);
    expect((await getOrgStorageQuota(northwind)).usedBytes).toBe(0);
  });

  it('WAL-9 (partial) the re-attribution is logged on the owner\'s counter with the drive, org and direction', async () => {
    const product = await seedDrive(marcus);
    await seedFile(product, lena, 250);
    await setCounter(marcus, 250);

    await moveDriveToOrg(marcus, product, { credential: 'session', orgId: northwind }, deps);

    expect(await db.select().from(storageEvents).where(eq(storageEvents.userId, lena))).toEqual([]);
    const events = await db.select().from(storageEvents).where(eq(storageEvents.userId, marcus));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'reattribute',
      sizeDelta: -250,
      totalSizeAfter: 0,
      metadata: { driveId: product, orgId: northwind, direction: 'into-org' },
    });
  });

  it('WAL-9 (partial) moving a drive out of the org queues its org-billed dedicated hosting to end at period end, in the move\'s transaction — never now, never a person\'s subscription (D-OW-64)', async () => {
    const product = await seedDrive(marcus, northwind);
    const envId = createId();
    await db.insert(driveEnvs).values({ id: envId, driveId: product, name: `env-${envId}`, createdBy: marcus, updatedAt: new Date() } as never);
    const appId = createId();
    await db.insert(publishedApps).values({
      id: appId, envId, driveId: product, ownerId: marcus, flyAppName: `pgs-${appId}`, networkName: 'published-apps',
      subdomain: `rel-${appId}`, machineId: `m-${appId}`, status: 'running', tier: 'dedicated', imageDigest: 'sha256:abc', updatedAt: new Date(),
    } as never);
    const subId = `sub_${appId}`;
    await db.insert(publishedAppSubscriptions).values({
      publishedAppId: appId, userId: jono, orgId: northwind, stripeSubscriptionId: subId, stripePriceId: 'price_small',
      guestPreset: 'shared-cpu-1x-512', status: 'active', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    });
    try {
      const moved = await moveDriveOutOfOrg(jono, product, { credential: 'session', implicitMembers: 'keep' }, deps);

      expect(moved.ok).toBe(true);
      const [reclaim] = await db.select().from(appHostingStripeReclaims).where(eq(appHostingStripeReclaims.stripeSubscriptionId, subId));
      expect(reclaim).toMatchObject({ publishedAppId: appId, cancelAt: 'period_end' });
    } finally {
      await db.delete(appHostingStripeReclaims).where(eq(appHostingStripeReclaims.stripeSubscriptionId, subId));
      await db.delete(publishedApps).where(eq(publishedApps.id, appId));
      await db.delete(driveEnvs).where(eq(driveEnvs.id, envId));
    }
  });

  it('WAL-9 (partial) moving a personal drive INTO the org queues its owner\'s personal dedicated hosting to end at period end, in the move\'s transaction — the org buys its own (D-OW-64)', async () => {
    const product = await seedDrive(marcus);
    const envId = createId();
    await db.insert(driveEnvs).values({ id: envId, driveId: product, name: `env-${envId}`, createdBy: marcus, updatedAt: new Date() } as never);
    const appId = createId();
    await db.insert(publishedApps).values({
      id: appId, envId, driveId: product, ownerId: marcus, flyAppName: `pgs-${appId}`, networkName: 'published-apps',
      subdomain: `in-${appId}`, machineId: `m-${appId}`, status: 'running', tier: 'dedicated', imageDigest: 'sha256:abc', updatedAt: new Date(),
    } as never);
    const subId = `sub_${appId}`;
    await db.insert(publishedAppSubscriptions).values({
      publishedAppId: appId, userId: marcus, orgId: null, stripeSubscriptionId: subId, stripePriceId: 'price_small',
      guestPreset: 'shared-cpu-1x-512', status: 'active', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    });
    try {
      const moved = await moveDriveToOrg(marcus, product, { credential: 'session', orgId: northwind }, deps);

      expect(moved.ok).toBe(true);
      const [reclaim] = await db.select().from(appHostingStripeReclaims).where(eq(appHostingStripeReclaims.stripeSubscriptionId, subId));
      expect(reclaim).toMatchObject({ publishedAppId: appId, cancelAt: 'period_end' });
    } finally {
      await db.delete(appHostingStripeReclaims).where(eq(appHostingStripeReclaims.stripeSubscriptionId, subId));
      await db.delete(publishedApps).where(eq(publishedApps.id, appId));
      await db.delete(driveEnvs).where(eq(driveEnvs.id, envId));
    }
  });

  it('WAL-9 (partial) a refused move re-attributes nothing', async () => {
    const product = await seedDrive(marcus);
    await seedFile(product, marcus, 1000);
    await setCounter(marcus, 1000);

    // Lena does not own the drive, so she cannot move it in.
    const refused = await moveDriveToOrg(lena, product, { credential: 'session', orgId: northwind }, deps);

    expect(refused.ok).toBe(false);
    expect(await counter(marcus)).toBe(1000);
    expect((await getOrgStorageQuota(northwind)).usedBytes).toBe(0);
  });
});

describe('handing a personal drive to a new owner re-attributes its bytes', () => {
  it('WAL-9 (partial) every byte in the drive leaves the old owner\'s counter and lands on the new owner\'s, atomically with drives.ownerId', async () => {
    const notes = await seedDrive(marcus);
    await seedFile(notes, marcus, 600);
    await seedFile(notes, lena, 400);
    await setCounter(marcus, 1000);
    await setCounter(lena, 5);

    await db.transaction(async (tx) => {
      await tx.update(drives).set({ ownerId: lena }).where(eq(drives.id, notes));
      await reattributeDriveOwnerStorageInTx(tx, { driveId: notes, fromUserId: marcus, toUserId: lena });
    });

    expect(await counter(marcus)).toBe(0);
    expect(await counter(lena)).toBe(1005);
    expect(await calculateActualStorageUsage(lena)).toBe(1000);
    expect(await calculateActualStorageUsage(marcus)).toBe(0);
  });
});

describe('the reconcile agrees with the attribution', () => {
  it('WAL-9 (partial) a person\'s derived usage is their personal drives\' files (whoever uploaded them) and their own DM attachments — never an org drive\'s, never another owner\'s drive — so the cron never bills bytes back onto the wrong person', async () => {
    const orgDrive = await seedDrive(marcus, northwind);
    const personal = await seedDrive(lena);
    const marcusDrive = await seedDrive(marcus);
    await seedFile(orgDrive, lena, 1000);
    await seedFile(personal, lena, 40);
    await seedFile(personal, marcus, 8); // Marcus uploaded into Lena's drive: Lena's bytes
    await seedFile(marcusDrive, lena, 300); // Lena uploaded into Marcus's drive: Marcus's bytes
    await seedFile(null, lena, 2); // a DM attachment: no drive, the uploader's
    await setCounter(lena, 50);
    await setCounter(marcus, 300);

    expect(await calculateActualStorageUsage(lena)).toBe(50);
    expect(await calculateActualStorageUsage(marcus)).toBe(300);
    const candidates = await storageRepository.findStorageDriftCandidates(1, 0);
    expect(candidates.find((c) => c.userId === lena)).toBeUndefined();
    expect(candidates.find((c) => c.userId === marcus)).toBeUndefined();
  });
});
