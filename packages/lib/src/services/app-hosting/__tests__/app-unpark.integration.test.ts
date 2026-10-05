/**
 * The way back out of `parked` (review 5407898542 P1): an app parked on its creator's allowance of
 * the org's credits comes back by itself when that allowance renews, and sooner when its creator,
 * the drive lead or an org Owner/Admin un-parks it — but only once the cap really has room, and
 * never when the org has turned published apps off.
 *
 * REAL: the un-park service, the permissions decision, the app billing gate (pool row lock, seat
 * cap), the POL-10 policy read, all against Postgres. Faked: the hosting kill switch (forced on) and
 * the audit chain (captured, as the policies suite does), and ORGS_ENABLED (on, as the org suites run).
 *
 * Requires DATABASE_URL → a migrated Postgres. Every row it creates is deleted.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { appHostingReclaims, publishedApps } from '@pagespace/db/schema/published-apps';
import { walletConsumerCaps, wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { DEFAULT_SEAT_ALLOWANCE_CENTS } from '../../../billing/wallet-core';
import { defaultAppRouterDeps } from '../router';
import { canUnparkPublishedApp } from '../../../permissions/app-unpark-authority';
import { defaultAppUnparkDeps, MEMBER_CAP_PARK_ERROR, releaseMemberCapParks, unparkPublishedApp, type AppUnparkDeps } from '../app-unpark';

const audit = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../../../audit/org-audit', () => ({
  recordOrgAuditEvent: vi.fn(async (event: Record<string, unknown>) => {
    audit.events.push(event);
  }),
  recordOrgAuditEventAfterCommit: vi.fn(async (event: Record<string, unknown>) => {
    audit.events.push(event);
    return true;
  }),
}));

vi.mock('../../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

const deps: AppUnparkDeps = { ...defaultAppUnparkDeps, isEnabled: () => true };

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;

interface World {
  orgId: string;
  driveId: string;
  poolId: string;
  leadId: string;
  creatorId: string;
  orgAdminId: string;
  memberId: string;
  envId: string;
  appId: string;
  userIds: string[];
}
let world: World | null = null;

/**
 * Northwind: Jono leads Product; Marcus (a member) published its app and has used his allowance, so
 * the app is parked on his cap. Ada is an org Admin; Pat is a plain member.
 */
async function build(): Promise<World> {
  const lead = await factories.createUser({ name: 'Jono (lead)', subscriptionTier: 'free' });
  const creator = await factories.createUser({ name: 'Marcus (creator)', subscriptionTier: 'free' });
  const orgAdmin = await factories.createUser({ name: 'Ada (org admin)', subscriptionTier: 'free' });
  const member = await factories.createUser({ name: 'Pat (member)', subscriptionTier: 'free' });
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: lead.id }).returning();
  // Paid: there is no org trial, and an unpaid org is lapsed from creation (D-OW-30).
  await factories.createOrgSubscription(org.id);
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: lead.id, role: 'OWNER' },
    { orgId: org.id, userId: creator.id, role: 'MEMBER' },
    { orgId: org.id, userId: orgAdmin.id, role: 'ADMIN' },
    { orgId: org.id, userId: member.id, role: 'MEMBER' },
  ]);
  const drive = await factories.createDrive(lead.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  const [poolWallet] = await db.insert(wallets).values({
    ownerType: 'org',
    orgId: org.id,
    monthlyRemainingCents: 900_000,
    monthlyPeriodStart: new Date(Date.now() - 5 * 86_400_000),
    monthlyPeriodEnd: new Date(Date.now() + 25 * 86_400_000),
  }).returning();
  const envId = createId();
  await db.insert(driveEnvs).values({ id: envId, driveId: drive.id, name: `env-${envId}`, createdBy: creator.id, costOwnerId: creator.id, sandboxId: `sbx-${envId}` });
  const appId = createId();
  await db.insert(publishedApps).values({
    id: appId,
    envId,
    driveId: drive.id,
    ownerId: creator.id,
    costOwnerId: creator.id,
    flyAppName: `pgs-${appId}`,
    networkName: 'published-apps',
    subdomain: `unpark-${appId}`.toLowerCase(),
    machineId: `m-${appId}`,
    status: 'parked',
    lastError: MEMBER_CAP_PARK_ERROR,
    tier: 'metered',
    imageDigest: 'sha256:abc',
    updatedAt: new Date(),
  } as never);
  const userIds = [lead.id, creator.id, orgAdmin.id, member.id];
  return { orgId: org.id, driveId: drive.id, poolId: poolWallet.id, leadId: lead.id, creatorId: creator.id, orgAdminId: orgAdmin.id, memberId: member.id, envId, appId, userIds };
}

async function teardown(w: World): Promise<void> {
  await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
  await db.delete(publishedApps).where(eq(publishedApps.id, w.appId));
  // Deleting an app row enqueues its Fly name for reclaim (the AFTER DELETE trigger): ours too.
  await db.delete(appHostingReclaims).where(eq(appHostingReclaims.publishedAppId, w.appId));
  await db.delete(driveEnvs).where(eq(driveEnvs.id, w.envId));
  await db.delete(walletConsumerCaps).where(eq(walletConsumerCaps.walletId, w.poolId));
  await db.delete(wallets).where(eq(wallets.id, w.poolId));
  await db.delete(drives).where(eq(drives.orgId, w.orgId));
  await db.delete(orgMembers).where(eq(orgMembers.orgId, w.orgId));
  await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, w.orgId));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

/** `userId` has spent their whole monthly allowance of the pool this period. */
async function atCap(w: World, userId: string): Promise<void> {
  const cents = DEFAULT_SEAT_ALLOWANCE_CENTS;
  await db.insert(creditLedger).values({ userId, walletId: w.poolId, entryType: 'usage', bucket: 'monthly', amountCents: -cents, appliedCents: -cents, chargeMillicents: cents * 1000, consumeStatus: 'applied', spendKind: 'ai' });
}

/** The pool refills (D-OW-12): its period rolls to start now, so every member's allowance is whole again. */
async function refill(w: World): Promise<void> {
  await db.update(wallets).set({ monthlyPeriodStart: new Date(), monthlyPeriodEnd: new Date(Date.now() + 30 * 86_400_000) }).where(eq(wallets.id, w.poolId));
}

const appRow = async (w: World) => (await db.select().from(publishedApps).where(eq(publishedApps.id, w.appId)))[0];
const holdsOf = async (w: World) => db.select().from(creditHolds).where(inArray(creditHolds.userId, w.userIds));

describe('a parked app has a way back', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: wallets.id }).from(wallets).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('app-unpark.integration.test.ts', error);
      dbAvailable = false;
    }
  });
  beforeEach(() => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    audit.events.length = 0;
  });
  afterEach(async () => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    if (world) await teardown(world);
    world = null;
  });
  afterAll(async () => {
    await pool.end();
  });

  it('WAL-2 (partial) an app parked on its creator\'s cap stays parked while the cap is reached and is un-parked automatically at the pool refill', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());
    await atCap(w, w.creatorId);

    expect(await releaseMemberCapParks(deps)).toMatchObject({ examined: 1, unparked: 0, stillCapped: 1 });
    expect((await appRow(w)).status).toBe('parked');

    await refill(w);
    expect(await releaseMemberCapParks(deps)).toMatchObject({ examined: 1, unparked: 1, stillCapped: 0 });
    const after = await appRow(w);
    expect([after.status, after.lastError]).toEqual(['stopped', null]);
    // The re-check reserved nothing it kept.
    expect(await holdsOf(w)).toEqual([]);
  });

  it('WAL-2 (partial) the paused page\'s "returns by" date is the drive\'s org pool refill', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());
    const [poolRow] = await db.select().from(wallets).where(eq(wallets.id, w.poolId));
    expect(await defaultAppRouterDeps.memberCapReturnsBy(w.driveId)).toEqual(poolRow.monthlyPeriodEnd);
  });

  it('POL-10 (partial) a cap reset does NOT un-park an app whose org has turned published apps off', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());
    await db.update(organizations).set({ policies: { publishedApps: false } }).where(eq(organizations.id, w.orgId));

    expect(await releaseMemberCapParks(deps)).toMatchObject({ examined: 1, unparked: 0, policyHeld: 1 });
    expect((await appRow(w)).status).toBe('parked');
  });

  it('WAL-2 (partial) the cap sweep touches only member-cap parks: an app parked for another reason stays parked', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());
    await db.update(publishedApps).set({ lastError: 'parked: insufficient_credits' }).where(eq(publishedApps.id, w.appId));

    expect(await releaseMemberCapParks(deps)).toMatchObject({ examined: 0, unparked: 0 });
    expect((await appRow(w)).status).toBe('parked');
  });

  it.each([
    ['creator', (w: World) => w.creatorId],
    ['lead', (w: World) => w.leadId],
    ['org-admin', (w: World) => w.orgAdminId],
  ] as const)('WAL-2 (partial) the %s may un-park it, and the un-park is audited as org.app.unparked', async (via, who) => {
    if (!dbAvailable) return;
    const w = (world = await build());
    const actorId = who(w);

    expect(await unparkPublishedApp({ publishedAppId: w.appId, actorId }, deps)).toEqual({ outcome: 'unparked', via });
    expect((await appRow(w)).status).toBe('stopped');
    expect(audit.events).toEqual([
      expect.objectContaining({ eventType: 'org.app.unparked', orgId: w.orgId, actorId, resourceType: 'published_app', resourceId: w.appId, driveId: w.driveId }),
    ]);
    expect(await holdsOf(w)).toEqual([]);
  });

  it('WAL-2 (partial) the pane asks the same authority: the creator, lead and org admin may un-park, a plain member may not', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());
    const app = { driveId: w.driveId, costOwnerId: w.creatorId };
    expect(await Promise.all([w.creatorId, w.leadId, w.orgAdminId, w.memberId].map((id) => canUnparkPublishedApp(id, app)))).toEqual([true, true, true, false]);
  });

  it('WAL-2 (partial) a plain member may not un-park it: refused, still parked, nothing audited', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());

    expect(await unparkPublishedApp({ publishedAppId: w.appId, actorId: w.memberId }, deps)).toEqual({ outcome: 'refused', reason: 'forbidden' });
    expect((await appRow(w)).status).toBe('parked');
    expect(audit.events).toEqual([]);
  });

  it('WAL-2 (partial) un-parking re-checks the creator\'s cap: still capped is REFUSED (not re-attributed to the admin), and it passes once the cap has room', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());
    await atCap(w, w.creatorId);

    expect(await unparkPublishedApp({ publishedAppId: w.appId, actorId: w.orgAdminId }, deps)).toEqual({
      outcome: 'held',
      held: 'still_capped',
      gateReason: 'org_member_cap_reached',
    });
    const held = await appRow(w);
    expect([held.status, held.costOwnerId]).toEqual(['parked', w.creatorId]);
    expect(audit.events).toEqual([]);
    expect(await holdsOf(w)).toEqual([]);

    await refill(w);
    expect(await unparkPublishedApp({ publishedAppId: w.appId, actorId: w.orgAdminId }, deps)).toEqual({ outcome: 'unparked', via: 'org-admin' });
    expect((await appRow(w)).costOwnerId).toBe(w.creatorId);
  });
});
