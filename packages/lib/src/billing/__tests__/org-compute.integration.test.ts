/**
 * Org-drive COMPUTE charges the ORG POOL (Spec WAL-9) — real Postgres, real gate, real settle.
 *
 * For every compute surface — sandbox runtime (the tool runner's metering, which the terminal
 * and browsers share), environments (an env-bound session's runtime, and the env's persisted
 * storage) and published apps (wake, awake window, stop) — this proves against the real tables:
 *
 *   - a FUNDED org drive's compute runs and the org pool is debited ONCE, as compute;
 *   - an EMPTY (or paused, or missing) org pool refuses before anything starts, and nothing is
 *     reserved or charged — above all no person's wallet (never a fallback);
 *   - a PERSONAL drive's compute is unchanged: its owner's own wallet pays.
 *
 * And the org backlog rule (point-guard ruling on ow-c7b): accrual an org row carried from
 * before org compute billing went live (the `billing_epochs` 'org_compute' stamp) is forgiven,
 * never charged — exactly once — while new, moved-in, and post-epoch-skipped rows bill in full.
 *
 * Requires DATABASE_URL → a migrated Postgres (requireDb fails loudly without one). Every row it
 * creates is deleted, children before parents, users last; the pool is ended by the lib
 * integration teardown.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { publishedApps, publishedAppMachineEvents } from '@pagespace/db/schema/published-apps';
import { billingEpochs, creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { defaultSandboxBillingDeps } from '../../services/sandbox/sandbox-billing';
import { withMachineBilling, type SandboxActorContext, type SandboxRunDeps } from '../../services/sandbox/tool-runners';
import { defaultReconcileSandboxStorageDeps, reconcileSandboxStorageSerialized } from '../../services/sandbox/sandbox-storage-billing';
import { reconcileSandboxStorage, MAX_BILLABLE_SPAN_MS, type ReconcileSandboxStorageDeps } from '../../services/sandbox/sandbox-storage-reconcile';
import {
  defaultAppLifecycleMeteringDeps,
  passThroughSettleLock,
  stopPublishedApp,
  wakePublishedApp,
  type AppLifecycleMeteringDeps,
} from '../../services/app-hosting/app-lifecycle-metering';
import { ORG_COMPUTE_EPOCH_KEY, stampOrgComputeBillingEpoch } from '../org-compute-epoch';
import { consumeCredits } from '../credit-consume';
import { AIMonitoring } from '../../monitoring/ai-monitoring';

const originalMode = process.env.DEPLOYMENT_MODE;
let dbAvailable = false;

interface World {
  orgId: string;
  leadId: string;
  memberId: string;
  soloId: string;
  orgDriveId: string;
  soloDriveId: string;
  poolId: string;
  leadWalletId: string;
  memberWalletId: string;
  soloWalletId: string;
  envIds: string[];
  appIds: string[];
  userIds: string[];
}

let world: World | null = null;

const FUNDED = 10_000;

async function personalWallet(userId: string, cents: number): Promise<string> {
  const [w] = await db.insert(wallets).values({
    userId,
    monthlyRemainingCents: cents,
    monthlyAllowanceCents: cents,
    monthlyPeriodStart: new Date(),
    monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  }).returning();
  return w.id;
}

async function build(input: { poolCents: number | null; poolStatus?: 'active' | 'paused' }): Promise<World> {
  const lead = await factories.createUser({ name: 'Jono (lead)', subscriptionTier: 'free' });
  const member = await factories.createUser({ name: 'Marcus Oyelaran', subscriptionTier: 'free' });
  const solo = await factories.createUser({ name: 'Priya (personal)', subscriptionTier: 'pro' });
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: lead.id }).returning();
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: lead.id, role: 'OWNER' },
    { orgId: org.id, userId: member.id, role: 'MEMBER' },
  ]);
  const orgDrive = await factories.createDrive(lead.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  const soloDrive = await factories.createDrive(solo.id, { name: 'Solo', slug: `solo-${createId()}` });
  let poolId = '';
  if (input.poolCents !== null) {
    const [pool] = await db.insert(wallets).values({
      ownerType: 'org',
      orgId: org.id,
      monthlyRemainingCents: input.poolCents,
      status: input.poolStatus ?? 'active',
    }).returning();
    poolId = pool.id;
  }
  return {
    orgId: org.id,
    leadId: lead.id,
    memberId: member.id,
    soloId: solo.id,
    orgDriveId: orgDrive.id,
    soloDriveId: soloDrive.id,
    poolId,
    leadWalletId: await personalWallet(lead.id, FUNDED),
    memberWalletId: await personalWallet(member.id, FUNDED),
    soloWalletId: await personalWallet(solo.id, FUNDED),
    envIds: [],
    appIds: [],
    userIds: [lead.id, member.id, solo.id],
  };
}

async function teardown(w: World): Promise<void> {
  if (w.appIds.length > 0) {
    await db.delete(publishedAppMachineEvents).where(inArray(publishedAppMachineEvents.publishedAppId, w.appIds));
    await db.delete(publishedApps).where(inArray(publishedApps.id, w.appIds));
  }
  if (w.envIds.length > 0) await db.delete(driveEnvs).where(inArray(driveEnvs.id, w.envIds));
  await db.delete(aiUsageLogs).where(inArray(aiUsageLogs.userId, w.userIds));
  await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
  if (w.poolId) await db.delete(wallets).where(eq(wallets.id, w.poolId));
  await db.delete(wallets).where(inArray(wallets.userId, w.userIds));
  await db.delete(drives).where(inArray(drives.id, [w.orgDriveId, w.soloDriveId]));
  await db.delete(orgMembers).where(eq(orgMembers.orgId, w.orgId));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

const walletRow = async (id: string) => (await db.select().from(wallets).where(eq(wallets.id, id)))[0];
const ledgerOnWallet = (walletId: string) => db.select().from(creditLedger).where(eq(creditLedger.walletId, walletId));
const holdsOnWallet = (walletId: string) => db.select().from(creditHolds).where(eq(creditHolds.walletId, walletId));

/** Millicents that actually left a wallet between two reads: whole cents drawn plus the sub-cent carry it grew by. */
function drawnMillicents(before: { monthlyRemainingCents: number; topupRemainingCents: number; debtCents: number; pendingMillicents: number }, after: typeof before): number {
  const cents = (before.monthlyRemainingCents - after.monthlyRemainingCents)
    + (before.topupRemainingCents - after.topupRemainingCents)
    + (after.debtCents - before.debtCents);
  return cents * 1000 + (after.pendingMillicents - before.pendingMillicents);
}

/** The personal wallets of everyone in the world, which an ORG charge must never touch. */
async function personalSnapshot(w: World) {
  const rows = await db.select().from(wallets).where(inArray(wallets.id, [w.leadWalletId, w.memberWalletId]));
  const ledger = await db.select().from(creditLedger).where(inArray(creditLedger.walletId, [w.leadWalletId, w.memberWalletId]));
  const holds = await db.select().from(creditHolds).where(inArray(creditHolds.walletId, [w.leadWalletId, w.memberWalletId]));
  return {
    balances: rows.map((r) => [r.id, r.monthlyRemainingCents, r.topupRemainingCents, r.debtCents, r.pendingMillicents]).sort(),
    ledger: ledger.length,
    holds: holds.length,
  };
}

function clock(startIso: string) {
  let t = new Date(startIso).getTime();
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}

/** The tool runner's metering, bound to the REAL sandbox billing deps, with a session in `driveId`. */
function meteredRun(input: { driveId: string | null; ownerId: string; activeMs: number }) {
  const c = clock('2026-09-28T10:00:00.000Z');
  let ran = 0;
  const deps = {
    billing: defaultSandboxBillingDeps,
    resolveBillingSession: async () => ({ workspaceId: `ws-${createId()}`, driveId: input.driveId, ownerId: input.ownerId }),
    now: c.now,
  } as unknown as SandboxRunDeps;
  const ctx = { userId: input.ownerId, tenantId: input.ownerId, conversationId: 'conv-1', actorEmail: 'a@example.com' } as SandboxActorContext;
  return {
    get ran() { return ran; },
    exec: () => withMachineBilling(ctx, deps, async () => {
      ran += 1;
      c.advance(input.activeMs);
      return { success: true as const, stdout: 'ok' };
    }),
  };
}

beforeAll(async () => {
  try {
    await db.select({ id: wallets.id }).from(wallets).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('org-compute.integration.test.ts', error);
  }
});

beforeEach(async () => {
  process.env.DEPLOYMENT_MODE = 'cloud';
  if (dbAvailable) await db.delete(billingEpochs).where(eq(billingEpochs.key, ORG_COMPUTE_EPOCH_KEY));
});

afterEach(async () => {
  process.env.DEPLOYMENT_MODE = originalMode;
  if (!dbAvailable) return;
  if (world) await teardown(world);
  world = null;
  await db.delete(billingEpochs).where(eq(billingEpochs.key, ORG_COMPUTE_EPOCH_KEY));
});

// ---------------------------------------------------------------------------------------------
// Sandbox runtime (the tool runner's metering; the terminal and browsers use the same deps)
// ---------------------------------------------------------------------------------------------

describe('sandbox runtime in an org drive', () => {
  it('WAL-9 (partial) a funded org drive runs, and the ORG POOL is debited once as compute — no person is touched', async () => {
    const w = (world = await build({ poolCents: FUNDED }));
    const people = await personalSnapshot(w);
    const poolBefore = await walletRow(w.poolId);

    const run = meteredRun({ driveId: w.orgDriveId, ownerId: w.memberId, activeMs: 3_600_000 });
    const result = await run.exec();

    const usage = (await ledgerOnWallet(w.poolId)).filter((r) => r.entryType === 'usage');
    const poolAfter = await walletRow(w.poolId);
    expect(result).toMatchObject({ success: true });
    expect(run.ran).toBe(1);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ userId: w.memberId, spendKind: 'compute', consumeStatus: 'applied' });
    expect(usage[0].chargeMillicents).toBeGreaterThan(0);
    expect(drawnMillicents(poolBefore, poolAfter)).toBe(usage[0].chargeMillicents);
    expect(await holdsOnWallet(w.poolId)).toEqual([]);
    expect(await personalSnapshot(w)).toEqual(people);
  });

  it.each([
    ['empty', { poolCents: 0 }, 'org_wallet_empty'],
    ['paused', { poolCents: FUNDED, poolStatus: 'paused' as const }, 'org_wallet_paused'],
    ['missing', { poolCents: null }, 'org_wallet_unavailable'],
  ])('WAL-9 (partial) an %s org pool refuses before the machine is touched — nothing reserved, nothing charged, no person billed', async (_label, input, reason) => {
    const w = (world = await build(input));
    const people = await personalSnapshot(w);

    const run = meteredRun({ driveId: w.orgDriveId, ownerId: w.memberId, activeMs: 3_600_000 });
    const result = await run.exec();

    expect(result).toMatchObject({ success: false, reason });
    expect(run.ran).toBe(0);
    expect(await db.select().from(creditHolds).where(inArray(creditHolds.userId, w.userIds))).toEqual([]);
    expect(await db.select().from(creditLedger).where(inArray(creditLedger.userId, w.userIds))).toEqual([]);
    expect(await personalSnapshot(w)).toEqual(people);
  });

  it("a personal drive's run is unchanged: its owner's own wallet pays", async () => {
    const w = (world = await build({ poolCents: FUNDED }));
    const before = await walletRow(w.soloWalletId);

    const result = await meteredRun({ driveId: w.soloDriveId, ownerId: w.soloId, activeMs: 3_600_000 }).exec();

    const usage = (await ledgerOnWallet(w.soloWalletId)).filter((r) => r.entryType === 'usage');
    expect(result).toMatchObject({ success: true });
    expect(usage).toHaveLength(1);
    expect(drawnMillicents(before, await walletRow(w.soloWalletId))).toBe(usage[0].chargeMillicents);
    expect(await ledgerOnWallet(w.poolId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Environments: an env-bound session's runtime, and the env's persisted storage
// ---------------------------------------------------------------------------------------------

async function seedEnv(w: World, driveId: string, storageLastBilledAt: Date): Promise<string> {
  const id = createId();
  await db.insert(driveEnvs).values({
    id,
    driveId,
    name: `env-${id}`,
    createdBy: w.memberId,
    sandboxId: `sbx-${id}`,
    storageLastBilledAt,
    storageMeasuredBytes: 5_000_000_000,
    storageMeasuredAt: new Date(storageLastBilledAt.getTime()),
    updatedAt: new Date(),
  } as never);
  w.envIds.push(id);
  return id;
}

/** The REAL storage deps (row sources narrowed to this world's envs), real charge, real watermark, real epoch. */
function storageDeps(w: World, now: () => Date, over: Partial<ReconcileSandboxStorageDeps> = {}): ReconcileSandboxStorageDeps {
  return {
    ...defaultReconcileSandboxStorageDeps,
    listAgentSessionSprites: async () => [],
    listPublishedAppRootfs: async () => [],
    listDriveEnvSprites: async () => (await defaultReconcileSandboxStorageDeps.listDriveEnvSprites()).filter((r) => w.envIds.includes(r.envId)),
    now,
    ...over,
  };
}

const envWatermark = async (id: string) => (await db.select({ at: driveEnvs.storageLastBilledAt }).from(driveEnvs).where(eq(driveEnvs.id, id)))[0]?.at;

describe('environments in an org drive', () => {
  it('WAL-9 (partial) an env-bound session in a funded org drive runs and the ORG POOL pays once; an empty pool refuses before the machine', async () => {
    const funded = (world = await build({ poolCents: FUNDED }));
    const run = meteredRun({ driveId: funded.orgDriveId, ownerId: funded.leadId, activeMs: 600_000 });
    expect(await run.exec()).toMatchObject({ success: true });
    expect((await ledgerOnWallet(funded.poolId)).filter((r) => r.entryType === 'usage' && r.spendKind === 'compute')).toHaveLength(1);
    await teardown(funded);

    const empty = (world = await build({ poolCents: 0 }));
    const refused = meteredRun({ driveId: empty.orgDriveId, ownerId: empty.leadId, activeMs: 600_000 });
    expect(await refused.exec()).toMatchObject({ success: false, reason: 'org_wallet_empty' });
    expect(refused.ran).toBe(0);
    expect(await db.select().from(creditLedger).where(inArray(creditLedger.userId, empty.userIds))).toEqual([]);
  });

  it("WAL-9 (partial) an org env's storage (after the epoch) is charged to the ORG POOL once, as a drive accrual, recorded under the lead — never the creator or the lead's wallet", async () => {
    const w = (world = await build({ poolCents: FUNDED }));
    const now = new Date('2026-09-28T12:00:00.000Z');
    await stampOrgComputeBillingEpoch(new Date('2026-09-27T00:00:00.000Z'));
    const envId = await seedEnv(w, w.orgDriveId, new Date(now.getTime() - MAX_BILLABLE_SPAN_MS));
    const people = await personalSnapshot(w);

    const result = await reconcileSandboxStorage(storageDeps(w, () => now));

    const usage = (await ledgerOnWallet(w.poolId)).filter((r) => r.entryType === 'usage');
    expect(result).toMatchObject({ charged: 1, orgBacklogForgiven: 0 });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ userId: w.leadId, spendKind: 'drive_compute' });
    expect(await envWatermark(envId)).toEqual(now);
    expect(await personalSnapshot(w)).toEqual(people);
  });

  it("a personal drive's env storage is unchanged: its owner pays", async () => {
    const w = (world = await build({ poolCents: FUNDED }));
    const now = new Date('2026-09-28T12:00:00.000Z');
    await seedEnv(w, w.soloDriveId, new Date(now.getTime() - MAX_BILLABLE_SPAN_MS));

    await reconcileSandboxStorage(storageDeps(w, () => now));

    expect((await ledgerOnWallet(w.soloWalletId)).filter((r) => r.entryType === 'usage')).toHaveLength(1);
    expect(await ledgerOnWallet(w.poolId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The org backlog: accrual from before org compute billing went live is forgiven, exactly once
// ---------------------------------------------------------------------------------------------

describe('the org compute billing epoch', () => {
  const TICK_1 = new Date('2026-09-28T12:00:00.000Z');
  const TICK_2 = new Date('2026-09-28T13:00:00.000Z');

  it('WAL-9 (partial) a pre-epoch org env is forgiven exactly once on the first org-billed tick, then bills normally on the second', async () => {
    const w = (world = await build({ poolCents: FUNDED }));
    const envId = await seedEnv(w, w.orgDriveId, new Date('2026-08-01T00:00:00.000Z'));

    const first = await reconcileSandboxStorage(storageDeps(w, () => TICK_1));
    expect(first).toMatchObject({ charged: 0, orgBacklogForgiven: 1 });
    expect(await ledgerOnWallet(w.poolId)).toEqual([]);
    expect(await envWatermark(envId)).toEqual(TICK_1);
    expect((await db.select().from(billingEpochs).where(eq(billingEpochs.key, ORG_COMPUTE_EPOCH_KEY)))[0]?.startedAt).toEqual(TICK_1);

    const second = await reconcileSandboxStorage(storageDeps(w, () => TICK_2));
    expect(second).toMatchObject({ charged: 1, orgBacklogForgiven: 0 });
    const usage = (await ledgerOnWallet(w.poolId)).filter((r) => r.entryType === 'usage');
    expect(usage).toHaveLength(1);
    expect(await envWatermark(envId)).toEqual(TICK_2);
  });

  it('a NEW org env created after the epoch bills its first interval in full', async () => {
    const w = (world = await build({ poolCents: FUNDED }));
    await stampOrgComputeBillingEpoch(new Date('2026-09-01T00:00:00.000Z'));
    await seedEnv(w, w.orgDriveId, new Date(TICK_1.getTime() - 3_600_000));

    const result = await reconcileSandboxStorage(storageDeps(w, () => TICK_1));

    expect(result).toMatchObject({ charged: 1, orgBacklogForgiven: 0 });
  });

  it('an env that MOVES into an org after the epoch bills normally (its personal billing already advanced it)', async () => {
    const w = (world = await build({ poolCents: FUNDED }));
    await stampOrgComputeBillingEpoch(new Date('2026-09-01T00:00:00.000Z'));
    const envId = await seedEnv(w, w.soloDriveId, new Date(TICK_1.getTime() - 3_600_000));
    await reconcileSandboxStorage(storageDeps(w, () => TICK_1));
    expect((await ledgerOnWallet(w.soloWalletId)).filter((r) => r.entryType === 'usage')).toHaveLength(1);

    await db.update(drives).set({ orgId: w.orgId }).where(eq(drives.id, w.soloDriveId));
    const result = await reconcileSandboxStorage(storageDeps(w, () => TICK_2));

    expect(result).toMatchObject({ charged: 1, orgBacklogForgiven: 0 });
    expect((await ledgerOnWallet(w.poolId)).filter((r) => r.entryType === 'usage')).toHaveLength(1);
    expect(await envWatermark(envId)).toEqual(TICK_2);
  });

  it('an org env SKIPPED after the epoch (unresolvable drive, then a failed charge) later bills its whole span — no accidental forgiveness', async () => {
    const w = (world = await build({ poolCents: FUNDED }));
    await stampOrgComputeBillingEpoch(new Date('2026-09-01T00:00:00.000Z'));
    const start = new Date(TICK_1.getTime() - 3_600_000);
    const envId = await seedEnv(w, w.orgDriveId, start);

    const unresolved = await reconcileSandboxStorage(storageDeps(w, () => TICK_1, { lookupDriveBillingFacts: async () => null }));
    expect(unresolved).toMatchObject({ charged: 0, skipped: 1, orgBacklogForgiven: 0 });
    const failed = await reconcileSandboxStorage(storageDeps(w, () => TICK_1, { chargeStorage: async () => ({ persisted: false, creditsSettled: false }) }));
    expect(failed).toMatchObject({ charged: 0, failed: 1, orgBacklogForgiven: 0 });
    expect(await envWatermark(envId)).toEqual(start);

    const reference = await reconcileSandboxStorage(storageDeps(w, () => TICK_2));
    expect(reference).toMatchObject({ charged: 1, orgBacklogForgiven: 0 });
    const [usage] = (await ledgerOnWallet(w.poolId)).filter((r) => r.entryType === 'usage');
    // The whole two-hour span since `start`, at 5GB: the same price a never-skipped row would pay.
    const expected = await priceOf(w, start, TICK_2);
    expect(usage.chargeMillicents).toBe(expected);
  });

  it('two concurrent first ticks stamp the epoch once and forgive the backlog once', async () => {
    const w = (world = await build({ poolCents: FUNDED }));
    await seedEnv(w, w.orgDriveId, new Date('2026-08-01T00:00:00.000Z'));

    const [a, b] = await Promise.all([stampOrgComputeBillingEpoch(TICK_1), stampOrgComputeBillingEpoch(TICK_2)]);
    expect(a).toEqual(b);
    expect(await db.select().from(billingEpochs).where(eq(billingEpochs.key, ORG_COMPUTE_EPOCH_KEY))).toHaveLength(1);
    await db.delete(billingEpochs).where(eq(billingEpochs.key, ORG_COMPUTE_EPOCH_KEY));

    const runs = await Promise.all([
      reconcileSandboxStorageSerialized(storageDeps(w, () => TICK_1)),
      reconcileSandboxStorageSerialized(storageDeps(w, () => TICK_1)),
    ]);
    // Whether the second run found the lock busy or ran after the first released it, the backlog
    // is forgiven once: a later run sees the watermark already moved past the epoch.
    const forgiven = runs.reduce((sum, r) => sum + (r.outcome === 'reconciled' ? r.orgBacklogForgiven : 0), 0);
    expect(forgiven).toBe(1);
    expect(await ledgerOnWallet(w.poolId)).toEqual([]);
  });
});

/** What an org env of this world pays for [from, to): the same deps on a throwaway env, read back from its charge. */
async function priceOf(w: World, from: Date, to: Date): Promise<number> {
  let captured = 0;
  const probe = await seedEnv(w, w.orgDriveId, from);
  const deps = storageDeps(w, () => to, {
    listDriveEnvSprites: async () => (await defaultReconcileSandboxStorageDeps.listDriveEnvSprites()).filter((r) => r.envId === probe),
    chargeStorage: async (input) => {
      const { chargeMillicents } = await import('../credit-core');
      const { MACHINE_MARKUP_BPS } = await import('../credit-pricing');
      captured = chargeMillicents(input.costDollars, MACHINE_MARKUP_BPS);
      return { persisted: false, creditsSettled: false };
    },
  });
  await reconcileSandboxStorage(deps);
  return captured;
}

// ---------------------------------------------------------------------------------------------
// Published apps: the wake holds on the pool, the stop settles once against it
// ---------------------------------------------------------------------------------------------

async function seedStoppedApp(w: World, driveId: string): Promise<string> {
  const envId = createId();
  await db.insert(driveEnvs).values({ id: envId, driveId, name: `app-env-${envId}`, createdBy: w.leadId, updatedAt: new Date() } as never);
  w.envIds.push(envId);
  const id = createId();
  await db.insert(publishedApps).values({
    id,
    envId,
    driveId,
    ownerId: w.leadId,
    flyAppName: `pgs-${id}`,
    networkName: 'published-apps',
    subdomain: `org-compute-${id}`,
    machineId: `m-${id}`,
    status: 'stopped',
    tier: 'metered',
    imageDigest: 'sha256:abc',
    updatedAt: new Date(),
  } as never);
  w.appIds.push(id);
  return id;
}

function appDeps(c: ReturnType<typeof clock>, started: { count: number }): AppLifecycleMeteringDeps {
  return {
    ...defaultAppLifecycleMeteringDeps,
    isEnabled: () => true,
    startMachine: async () => { started.count += 1; },
    stopMachine: async () => {},
    listMachineEvents: async () => [],
    serializeSettle: passThroughSettleLock,
    dailyAwakeCapSeconds: () => 0,
    now: c.now,
  };
}

describe('published apps in an org drive', () => {
  it('WAL-9 (partial) a funded org app wakes on a hold against the ORG POOL, and its stop settles once there as a drive accrual', async () => {
    const w = (world = await build({ poolCents: FUNDED }));
    await stampOrgComputeBillingEpoch(new Date('2026-01-01T00:00:00.000Z'));
    const appId = await seedStoppedApp(w, w.orgDriveId);
    const people = await personalSnapshot(w);
    const c = clock('2026-09-28T10:00:00.000Z');
    const started = { count: 0 };
    const poolBefore = await walletRow(w.poolId);

    const woken = await wakePublishedApp(appId, appDeps(c, started));
    expect(woken).toMatchObject({ outcome: 'woken' });
    expect(started.count).toBe(1);
    expect(await holdsOnWallet(w.poolId)).toHaveLength(1);

    c.advance(3_600_000);
    const stopped = await stopPublishedApp(appId, 'idle', appDeps(c, started));
    expect(stopped).toMatchObject({ outcome: 'stopped', billedSeconds: 3600 });

    const usage = (await ledgerOnWallet(w.poolId)).filter((r) => r.entryType === 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ userId: w.leadId, spendKind: 'drive_compute' });
    expect(drawnMillicents(poolBefore, await walletRow(w.poolId))).toBe(usage[0].chargeMillicents);
    expect(await holdsOnWallet(w.poolId)).toEqual([]);
    expect(await personalSnapshot(w)).toEqual(people);
  });

  it('WAL-9 (partial) an EMPTY org pool parks the app — no machine started, nothing reserved or charged, no person billed', async () => {
    const w = (world = await build({ poolCents: 0 }));
    const appId = await seedStoppedApp(w, w.orgDriveId);
    const people = await personalSnapshot(w);
    const started = { count: 0 };

    const result = await wakePublishedApp(appId, appDeps(clock('2026-09-28T10:00:00.000Z'), started));

    expect(result).toEqual({ outcome: 'parked', reason: 'org_wallet_empty' });
    expect(started.count).toBe(0);
    expect(await db.select().from(creditHolds).where(inArray(creditHolds.userId, w.userIds))).toEqual([]);
    expect(await db.select().from(creditLedger).where(inArray(creditLedger.userId, w.userIds))).toEqual([]);
    expect(await personalSnapshot(w)).toEqual(people);
  });

  it("a personal drive's app is unchanged: its owner's wallet holds and pays", async () => {
    const w = (world = await build({ poolCents: FUNDED }));
    const appId = await seedStoppedApp(w, w.soloDriveId);
    await db.update(publishedApps).set({ ownerId: w.soloId }).where(eq(publishedApps.id, appId));
    const c = clock('2026-09-28T10:00:00.000Z');
    const started = { count: 0 };

    await wakePublishedApp(appId, appDeps(c, started));
    c.advance(600_000);
    await stopPublishedApp(appId, 'idle', appDeps(c, started));

    expect((await ledgerOnWallet(w.soloWalletId)).filter((r) => r.entryType === 'usage')).toHaveLength(1);
    expect(await ledgerOnWallet(w.poolId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The payer changes mid-window (review 5343636479 P1-1): never settle across the change
// ---------------------------------------------------------------------------------------------

describe('a payer change while an app is awake', () => {
  it("WAL-9 (partial) a drive moved INTO an org mid-wake settles on the ORG POOL — the person's wallet is untouched and the stale hold released", async () => {
    const w = (world = await build({ poolCents: FUNDED }));
    await stampOrgComputeBillingEpoch(new Date('2026-01-01T00:00:00.000Z'));
    const appId = await seedStoppedApp(w, w.soloDriveId);
    await db.update(publishedApps).set({ ownerId: w.soloId }).where(eq(publishedApps.id, appId));
    const c = clock('2026-09-28T10:00:00.000Z');
    const started = { count: 0 };

    await wakePublishedApp(appId, appDeps(c, started));
    const [staleHold] = await holdsOnWallet(w.soloWalletId);
    expect(staleHold).toBeDefined();
    const soloBefore = await walletRow(w.soloWalletId);
    const poolBefore = await walletRow(w.poolId);

    await db.update(drives).set({ orgId: w.orgId }).where(eq(drives.id, w.soloDriveId));
    c.advance(3_600_000);
    const stopped = await stopPublishedApp(appId, 'idle', appDeps(c, started));

    expect(stopped).toMatchObject({ outcome: 'stopped', billedSeconds: 3600 });
    const usage = (await ledgerOnWallet(w.poolId)).filter((r) => r.entryType === 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ spendKind: 'drive_compute', consumeStatus: 'applied' });
    expect(drawnMillicents(poolBefore, await walletRow(w.poolId))).toBe(usage[0].chargeMillicents);
    expect(await ledgerOnWallet(w.soloWalletId)).toEqual([]);
    expect(await walletRow(w.soloWalletId)).toEqual(soloBefore);
    expect(await db.select().from(creditHolds).where(eq(creditHolds.id, staleHold.id))).toEqual([]);
    expect(await holdsOnWallet(w.poolId)).toEqual([]);
  });

  it("WAL-9 (partial) a drive moved OUT of an org mid-wake settles on its owner's own wallet — the org pool is untouched", async () => {
    const w = (world = await build({ poolCents: FUNDED }));
    await stampOrgComputeBillingEpoch(new Date('2026-01-01T00:00:00.000Z'));
    const appId = await seedStoppedApp(w, w.orgDriveId);
    const c = clock('2026-09-28T10:00:00.000Z');
    const started = { count: 0 };

    await wakePublishedApp(appId, appDeps(c, started));
    expect(await holdsOnWallet(w.poolId)).toHaveLength(1);
    const poolBefore = await walletRow(w.poolId);

    await db.update(drives).set({ orgId: null }).where(eq(drives.id, w.orgDriveId));
    c.advance(3_600_000);
    await stopPublishedApp(appId, 'idle', appDeps(c, started));

    expect((await ledgerOnWallet(w.leadWalletId)).filter((r) => r.entryType === 'usage')).toHaveLength(1);
    expect(await ledgerOnWallet(w.poolId)).toEqual([]);
    expect(await walletRow(w.poolId)).toEqual(poolBefore);
    expect(await holdsOnWallet(w.poolId)).toEqual([]);
  });

  it('a settle whose charge names a different wallet than its hold is REFUSED by consumeCredits — neither wallet charged, the call closed so no sweep bills it', async () => {
    const w = (world = await build({ poolCents: FUNDED }));
    const [hold] = await db.insert(creditHolds).values({ userId: w.leadId, walletId: w.leadWalletId, estCents: 50, expiresAt: new Date(Date.now() + 600_000), spendKind: 'compute' }).returning();
    const [log] = await db.insert(aiUsageLogs).values({ id: createId(), userId: w.leadId, provider: 'fly', model: 'x', cost: 0.5, source: 'terminal', timestamp: new Date() }).returning();
    const leadBefore = await walletRow(w.leadWalletId);
    const poolBefore = await walletRow(w.poolId);

    const status = await consumeCredits({ aiUsageLogId: log.id, userId: w.leadId, costDollars: 0.5, holdId: hold.id, walletId: w.poolId, spendKind: 'compute' });

    expect(status).toBe('refused');
    expect(await walletRow(w.leadWalletId)).toEqual(leadBefore);
    expect(await walletRow(w.poolId)).toEqual(poolBefore);
    const [claim] = await db.select().from(creditLedger).where(eq(creditLedger.aiUsageLogId, log.id));
    expect(claim).toMatchObject({ consumeStatus: 'skipped', chargeMillicents: 0, amountCents: 0 });
    expect(claim.consumeError).toMatch(/hold_wallet_mismatch/);
    expect(await db.select().from(creditHolds).where(eq(creditHolds.id, hold.id))).toEqual([]);
  });

  it('AIMonitoring.trackUsage refuses a mismatched hold BEFORE writing anything — no usage row, no ledger row, the window stays open', async () => {
    const w = (world = await build({ poolCents: FUNDED }));
    const [hold] = await db.insert(creditHolds).values({ userId: w.leadId, walletId: w.leadWalletId, estCents: 50, expiresAt: new Date(Date.now() + 600_000), spendKind: 'compute' }).returning();

    const outcome = await AIMonitoring.trackUsage({
      userId: w.leadId,
      walletId: w.poolId,
      holdId: hold.id,
      provider: 'fly',
      model: 'published-app-awake',
      source: 'terminal',
      providerCostDollars: 0.5,
      success: true,
      costSource: 'list_price',
      spendKind: 'compute',
    });

    expect(outcome).toEqual({ persisted: false, creditsSettled: false });
    expect(await db.select().from(aiUsageLogs).where(inArray(aiUsageLogs.userId, w.userIds))).toEqual([]);
    expect(await db.select().from(creditLedger).where(inArray(creditLedger.userId, w.userIds))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Settlement keeps the wallet and the kind (the orphan recovery re-settles the same way)
// ---------------------------------------------------------------------------------------------

describe('settling an org compute charge', () => {
  it('WAL-9 (partial) a charge that names the org pool and compute lands there, marked compute — and a personal default stays ai', async () => {
    const w = (world = await build({ poolCents: FUNDED }));
    const [orgLog] = await db.insert(aiUsageLogs).values({ id: createId(), userId: w.leadId, provider: 'fly', model: 'x', cost: 0.5, source: 'terminal', timestamp: new Date() }).returning();
    const [aiLog] = await db.insert(aiUsageLogs).values({ id: createId(), userId: w.memberId, provider: 'openrouter', model: 'y', cost: 0.5, source: 'chat', timestamp: new Date() }).returning();

    await consumeCredits({ aiUsageLogId: orgLog.id, userId: w.leadId, costDollars: 0.5, walletId: w.poolId, spendKind: 'compute' });
    await consumeCredits({ aiUsageLogId: aiLog.id, userId: w.memberId, costDollars: 0.5 });

    const [orgRow] = await db.select().from(creditLedger).where(and(eq(creditLedger.aiUsageLogId, orgLog.id), eq(creditLedger.entryType, 'usage')));
    const [aiRow] = await db.select().from(creditLedger).where(and(eq(creditLedger.aiUsageLogId, aiLog.id), eq(creditLedger.entryType, 'usage')));
    expect(orgRow).toMatchObject({ walletId: w.poolId, spendKind: 'compute' });
    expect(aiRow).toMatchObject({ walletId: w.memberWalletId, spendKind: 'ai' });
  });
});
