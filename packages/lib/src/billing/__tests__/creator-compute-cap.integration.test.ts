/**
 * [D-OW-28] Environments and published apps a member creates in an org drive are attributed to
 * that member: their storage, wakes and awake time are recorded under, and capped against, the
 * creator — the same per-member cap as the compute they run — under the same discipline (read under
 * the pool row's lock in the hold's transaction; bound at settlement too). A member at their cap
 * cannot create one, and its wakes are refused. When the creator leaves the org, the resources keep
 * running and their costs move to the drive's LEAD, audited as `org.compute.reattributed`.
 *
 * REAL: the creation admission, the app billing deps (resolveCharge → gate → trackUsage), the
 * storage charge, leaveOrganization, all against Postgres. Faked: only the audit chain (a separate
 * store), captured as the policies suite does.
 *
 * Requires DATABASE_URL → a migrated Postgres. Every row it creates is deleted.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { appHostingReclaims, publishedApps } from '@pagespace/db/schema/published-apps';
import { walletConsumerCaps, wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { admitDriveComputeCreator } from '../compute-gate';
import { defaultAppBillingDeps } from '../../services/app-hosting/app-billing';
import { leaveOrganization } from '../../organizations/leave';
import { createDbDriveEnvStore } from '../../services/drive-envs/drive-envs-store';
import { createPublishedApp, defaultProvisionerDeps } from '../../services/app-hosting/provisioner';
import { DEFAULT_SEAT_ALLOWANCE_CENTS } from '../wallet-core';

const audit = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../../audit/org-audit', () => ({
  recordOrgAuditEvent: vi.fn(async (event: Record<string, unknown>) => {
    audit.events.push(event);
  }),
  recordOrgAuditEventAfterCommit: vi.fn(async (event: Record<string, unknown>) => {
    audit.events.push(event);
    return true;
  }),
}));

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;

interface World {
  orgId: string;
  driveId: string;
  poolId: string;
  leadId: string;
  marcusId: string;
  envId: string;
  appId: string;
  userIds: string[];
  /** Envs and apps a test created through the real create/publish paths. */
  extraEnvIds: string[];
  extraAppIds: string[];
}
let world: World | null = null;

/** Northwind: Jono leads Product; Marcus (a member) created an env in it and published its app. */
async function build(): Promise<World> {
  const lead = await factories.createUser({ name: 'Jono (lead)', subscriptionTier: 'free' });
  const marcus = await factories.createUser({ name: 'Marcus (creator)', subscriptionTier: 'free' });
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: lead.id }).returning();
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: lead.id, role: 'OWNER' },
    { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
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
  await db.insert(driveEnvs).values({ id: envId, driveId: drive.id, name: `env-${envId}`, createdBy: marcus.id, costOwnerId: marcus.id, sandboxId: `sbx-${envId}` });
  const appId = createId();
  await db.insert(publishedApps).values({
    id: appId,
    envId,
    driveId: drive.id,
    ownerId: marcus.id,
    costOwnerId: marcus.id,
    flyAppName: `pgs-${appId}`,
    networkName: 'published-apps',
    subdomain: `creator-cap-${appId}`.toLowerCase(),
    machineId: `m-${appId}`,
    status: 'stopped',
    tier: 'metered',
    imageDigest: 'sha256:abc',
    updatedAt: new Date(),
  } as never);
  return { orgId: org.id, driveId: drive.id, poolId: poolWallet.id, leadId: lead.id, marcusId: marcus.id, envId, appId, userIds: [lead.id, marcus.id], extraEnvIds: [], extraAppIds: [] };
}

async function teardown(w: World): Promise<void> {
  await db.delete(aiUsageLogs).where(inArray(aiUsageLogs.userId, w.userIds));
  await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
  const appIds = [w.appId, ...w.extraAppIds];
  await db.delete(publishedApps).where(inArray(publishedApps.id, appIds));
  // Deleting an app row enqueues its Fly name for reclaim (the AFTER DELETE trigger): ours too.
  await db.delete(appHostingReclaims).where(inArray(appHostingReclaims.publishedAppId, appIds));
  await db.delete(driveEnvs).where(inArray(driveEnvs.id, [w.envId, ...w.extraEnvIds]));
  await db.delete(walletConsumerCaps).where(eq(walletConsumerCaps.walletId, w.poolId));
  await db.delete(wallets).where(eq(wallets.id, w.poolId));
  await db.delete(drives).where(eq(drives.orgId, w.orgId));
  await db.delete(orgMembers).where(eq(orgMembers.orgId, w.orgId));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

/** `userId` has spent their whole monthly allowance of the pool on AI this period. */
async function atCap(w: World, userId: string): Promise<void> {
  const cents = DEFAULT_SEAT_ALLOWANCE_CENTS;
  await db.insert(creditLedger).values({ userId, walletId: w.poolId, entryType: 'usage', bucket: 'monthly', amountCents: -cents, appliedCents: -cents, chargeMillicents: cents * 1000, consumeStatus: 'applied', spendKind: 'ai' });
}

const appRow = async (w: World) => (await db.select().from(publishedApps).where(eq(publishedApps.id, w.appId)))[0];
const envRow = async (w: World) => (await db.select().from(driveEnvs).where(eq(driveEnvs.id, w.envId)))[0];
const usageOf = async (w: World, userId: string) =>
  (await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))).filter((r) => r.entryType === 'usage' && r.walletId === w.poolId && r.spendKind === 'drive_compute');
/** The app's wake charge, resolved exactly as every app billing site does — from its row. */
async function wakeCharge(w: World) {
  const app = await appRow(w);
  const charge = await defaultAppBillingDeps.resolveCharge({ driveId: app.driveId, costOwnerId: app.costOwnerId });
  if (!charge) throw new Error('charge unresolved');
  return charge;
}

describe('environments and apps are capped against the member who created them ([D-OW-28])', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: wallets.id }).from(wallets).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('creator-compute-cap.integration.test.ts', error);
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

  it('WAL-2 (partial) a member at their cap cannot create a billable env or app; under the cap they can, and nothing stays reserved', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());

    expect(await admitDriveComputeCreator({ driveId: w.driveId, userId: w.marcusId })).toEqual({ allowed: true });
    expect(await db.select().from(creditHolds).where(eq(creditHolds.userId, w.marcusId))).toEqual([]);

    await atCap(w, w.marcusId);
    expect(await admitDriveComputeCreator({ driveId: w.driveId, userId: w.marcusId })).toEqual({ allowed: false, message: expect.stringMatching(/used your allowance/) });
    // The lead, whose allowance is whole, still can.
    expect(await admitDriveComputeCreator({ driveId: w.driveId, userId: w.leadId })).toEqual({ allowed: true });
  });

  it('WAL-2 (partial) the app of a member at their cap cannot wake: the wake gate refuses on THEIR cap, not the funded pool', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());
    await atCap(w, w.marcusId);

    const charge = await wakeCharge(w);
    expect(charge).toEqual({ kind: 'org', orgId: w.orgId, userId: w.marcusId, accrual: true });
    expect(await defaultAppBillingDeps.gate({ charge })).toMatchObject({ allowed: false, orgRefusal: 'org_member_cap_reached' });
    expect(await db.select().from(creditHolds).where(inArray(creditHolds.userId, w.userIds))).toEqual([]);
  });

  it('WAL-2 (partial) a member under their cap is charged for their OWN app and env — never the lead', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());

    const charge = await wakeCharge(w);
    const held = await defaultAppBillingDeps.gate({ charge });
    expect(held).toMatchObject({ allowed: true });
    expect(await defaultAppBillingDeps.trackUsage({ charge, holdId: held.holdId, activeSeconds: 600, driveId: w.driveId, publishedAppId: w.appId })).toMatchObject({ persisted: true });

    expect((await usageOf(w, w.marcusId)).length).toBe(1);
    expect(await usageOf(w, w.leadId)).toEqual([]);
    // The env resolves the same way: its storage counts against Marcus too.
    expect((await envRow(w)).costOwnerId).toBe(w.marcusId);
  });

  it('WAL-2 (partial) the creator leaves the org: the env and app keep running, their costs go to the drive LEAD, and the re-attribution is audited', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());

    const left = await leaveOrganization(w.marcusId, w.orgId);

    expect(left.ok).toBe(true);
    if (!left.ok) return;
    expect(left.computeReattributed.map((r) => [r.kind, r.id])).toEqual([['drive_env', w.envId], ['published_app', w.appId]]);
    // Nothing deleted or suspended: both rows are as they were, only unattributed.
    expect([(await envRow(w)).costOwnerId, (await appRow(w)).costOwnerId, (await appRow(w)).status]).toEqual([null, null, 'stopped']);
    // The next charge is the lead's, capped against the lead.
    expect(await wakeCharge(w)).toEqual({ kind: 'org', orgId: w.orgId, userId: w.leadId, accrual: true });
    // The leave itself is recorded too (AUD-1, #2759); the re-attributions are their own events.
    expect(audit.events.map((e) => e.eventType)).toContain('org.member.left');
    expect(audit.events.filter((e) => e.eventType === 'org.compute.reattributed')).toEqual([
      expect.objectContaining({ orgId: w.orgId, eventType: 'org.compute.reattributed', resourceType: 'drive_env', resourceId: w.envId, driveId: w.driveId, details: { formerCostOwnerId: w.marcusId, costOwner: 'drive_lead' } }),
      expect.objectContaining({ orgId: w.orgId, eventType: 'org.compute.reattributed', resourceType: 'published_app', resourceId: w.appId, driveId: w.driveId }),
    ]);
    // A leave that is refused (the Owner) re-attributes and audits nothing.
    audit.events.length = 0;
    expect(await leaveOrganization(w.leadId, w.orgId)).toMatchObject({ ok: false });
    expect(audit.events).toEqual([]);
  });

  it('WAL-2 (partial) creating an env through the real store records its CREATOR as the cost owner, not the lead', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());
    const store = await createDbDriveEnvStore();

    const created = await store.createIfUnderLimit({ driveId: w.driveId, name: `marcus-${createId()}`, createdBy: w.marcusId, now: new Date(), payerId: w.leadId, maxEnvs: 99 });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    w.extraEnvIds.push(created.env.id);
    expect((await db.select().from(driveEnvs).where(eq(driveEnvs.id, created.env.id)))[0].costOwnerId).toBe(w.marcusId);
  });

  it('WAL-2 (partial) publishing through the real provisioner records the PUBLISHER as the app\'s cost owner, not the lead', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());
    const envId = createId();
    w.extraEnvIds.push(envId);
    await db.insert(driveEnvs).values({ id: envId, driveId: w.driveId, name: `env-${envId}`, createdBy: w.marcusId, costOwnerId: w.marcusId, sandboxId: `sbx-${envId}` });

    const published = await createPublishedApp({
      envId,
      driveId: w.driveId,
      ownerId: w.marcusId,
      subdomain: `stamp-${envId}`.toLowerCase(),
      orgSlug: 'acme',
      deps: { ...defaultProvisionerDeps, isEnabled: () => true, resolveNetwork: () => 'published-apps', createFlyApp: async () => {}, publishedAppsAllowed: async () => true },
    });

    expect(published.ok).toBe(true);
    if (!published.ok) return;
    w.extraAppIds.push(published.app.id);
    expect((await db.select().from(publishedApps).where(eq(publishedApps.id, published.app.id)))[0].costOwnerId).toBe(w.marcusId);
  });

  /** Force GENUINE overlap: every hold INSERT for `userId` sleeps inside Postgres while `fn` runs. */
  async function withSlowHoldInserts<T>(userId: string, fn: () => Promise<T>, ms = 400): Promise<T> {
    const name = `test_slow_hold_${createId().slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    await db.execute(sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(${ms / 1000}); RETURN NEW; END $$ LANGUAGE plpgsql`));
    await db.execute(sql.raw(`CREATE TRIGGER ${name} BEFORE INSERT ON credit_holds FOR EACH ROW WHEN (NEW."userId" = '${userId}') EXECUTE FUNCTION ${name}()`));
    try {
      return await fn();
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${name} ON credit_holds`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${name}()`));
    }
  }

  it('WAL-2 (partial) two SIMULTANEOUS wakes of a member\'s app against room for one: exactly one passes, decided under the pool lock', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());
    // A monthly cap of exactly one wake's reservation: room for one.
    const charge = await wakeCharge(w);
    const probe = await defaultAppBillingDeps.gate({ charge });
    if (!probe.allowed || !probe.holdId) throw new Error('probe gate refused');
    const [probeHold] = await db.select().from(creditHolds).where(eq(creditHolds.id, probe.holdId));
    await db.delete(creditHolds).where(eq(creditHolds.id, probe.holdId));
    await db.insert(walletConsumerCaps).values({ walletId: w.poolId, consumerKey: `user:${w.marcusId}`, monthlyCapCents: probeHold.estCents });

    const both = await withSlowHoldInserts(w.marcusId, () => Promise.all([0, 1].map(() => defaultAppBillingDeps.gate({ charge }))));

    expect(both.filter((g) => g.allowed)).toHaveLength(1);
    expect(both.find((g) => !g.allowed)).toMatchObject({ allowed: false, orgRefusal: 'org_member_cap_reached' });
    expect((await db.select().from(creditHolds).where(eq(creditHolds.userId, w.marcusId))).map((h) => h.spendKind)).toEqual(['drive_compute']);
  });
});
