/**
 * Per-consumer caps on drive-wallet and seat legs against a real Postgres (Spec WAL-7): who may
 * write them (org Owner/Admins on an org leg, the wallet's owner on a personal leg), that a cap
 * binds the drive-wallet leg in the gate, and that the funder is alerted at 80% and 100% exactly
 * once per threshold per window per period.
 *
 * Northwind (Sequence Spec fixture): Jono owns the org, Ana is an Admin, Marcus a member, Lena a
 * member who leads Product, the org drive; Jono also has a personal drive, Side Project.
 *
 * Requires DATABASE_URL → a migrated Postgres; fails loudly without one (requireDb).
 * Deletes every row it creates, children before parents, users last, and ends the pool.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { notifications } from '@pagespace/db/schema/notifications';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { walletCapAlerts, walletConsumerCaps, wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { canConsumeAI } from '../credit-gate';
import { consumeCredits } from '../credit-consume';
import { automationSpend, driveSpend, personTriggeredSpend } from '../spend-target';
import { notifyCapAlerts } from '../wallet-cap-alerts';
import { listDriveWalletCaps, setDriveWalletCap, setSeatCap } from '../../services/drive-wallet-service';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

// A seam AFTER the unlocked resolution returns: a test changes the world before the gate's locked re-check.
const afterResolution = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }));
vi.mock('../spend-resolution', async (importOriginal) => {
  const real = await importOriginal<typeof import('../spend-resolution')>();
  return {
    ...real,
    resolveCallSpend: async (...args: Parameters<typeof real.resolveCallSpend>) => {
      const decision = await real.resolveCallSpend(...args);
      if (afterResolution.run) await afterResolution.run();
      return decision;
    },
  };
});

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;

interface World {
  orgId: string;
  productId: string;
  sideId: string;
  jonoId: string;
  anaId: string;
  marcusId: string;
  lenaId: string;
  poolId: string;
  productWalletId: string;
  sideWalletId: string;
  jonoRootId: string;
  userIds: string[];
}
let world: World | null = null;

async function build(): Promise<World> {
  const jono = await factories.createUser({ name: 'Jono', subscriptionTier: 'pro' });
  const ana = await factories.createUser({ name: 'Ana Admin', subscriptionTier: 'free' });
  const marcus = await factories.createUser({ name: 'Marcus Oyelaran', subscriptionTier: 'free' });
  const lena = await factories.createUser({ name: 'Lena Lead', subscriptionTier: 'free' });
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: jono.id, stripeCustomerId: `cus_${createId()}` }).returning();
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: jono.id, role: 'OWNER' },
    { orgId: org.id, userId: ana.id, role: 'ADMIN' },
    { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
    { orgId: org.id, userId: lena.id, role: 'MEMBER' },
  ]);
  const product = await factories.createDrive(lena.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  await factories.createDriveMember(product.id, marcus.id, { source: 'org' });
  const [poolWallet] = await db.insert(wallets).values({
    ownerType: 'org', orgId: org.id, monthlyRemainingCents: 50_000,
    monthlyPeriodStart: new Date(Date.now() - 10 * 86_400_000), monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  }).returning();
  const [productWallet] = await db.insert(wallets).values({
    ownerType: 'org', orgId: org.id, subjectType: 'drive', subjectId: product.id, parentWalletId: poolWallet.id, monthlyAllowanceCents: 10_000,
  }).returning();
  const [jonoRoot] = await db.insert(wallets).values({ userId: jono.id, monthlyRemainingCents: 9_000, monthlyPeriodStart: new Date(), monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000) }).returning();
  const side = await factories.createDrive(jono.id, { name: 'Side Project', slug: `side-${createId()}` });
  await factories.createDriveMember(side.id, marcus.id, { source: 'invite' });
  const [sideWallet] = await db.insert(wallets).values({ userId: jono.id, subjectType: 'drive', subjectId: side.id, parentWalletId: jonoRoot.id, monthlyAllowanceCents: 1_000 }).returning();
  return {
    orgId: org.id, productId: product.id, sideId: side.id, jonoId: jono.id, anaId: ana.id, marcusId: marcus.id, lenaId: lena.id,
    poolId: poolWallet.id, productWalletId: productWallet.id, sideWalletId: sideWallet.id, jonoRootId: jonoRoot.id,
    userIds: [jono.id, ana.id, marcus.id, lena.id],
  };
}

async function teardown(w: World): Promise<void> {
  await db.delete(notifications).where(inArray(notifications.userId, w.userIds));
  await db.delete(aiUsageLogs).where(inArray(aiUsageLogs.userId, w.userIds));
  await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
  await db.delete(walletCapAlerts).where(inArray(walletCapAlerts.walletId, [w.poolId, w.productWalletId, w.sideWalletId]));
  await db.delete(walletConsumerCaps).where(inArray(walletConsumerCaps.walletId, [w.poolId, w.productWalletId, w.sideWalletId]));
  await db.delete(wallets).where(inArray(wallets.id, [w.productWalletId, w.sideWalletId]));
  await db.delete(wallets).where(inArray(wallets.id, [w.poolId, w.jonoRootId]));
  await db.delete(wallets).where(inArray(wallets.userId, w.userIds));
  await db.delete(drives).where(inArray(drives.id, [w.productId, w.sideId]));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

const capRow = async (walletId: string, userId: string) =>
  (await db.select().from(walletConsumerCaps).where(and(eq(walletConsumerCaps.walletId, walletId), eq(walletConsumerCaps.consumerKey, `user:${userId}`))))[0] ?? null;
const capAlertsFor = (userId: string) =>
  db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, 'WALLET_CAP_ALERT')));

/** A settled call by Marcus on `walletId` charging `costDollars` (1.5x markup: $0.10 → 15¢). */
async function settledCall(w: World, driveId: string, costDollars: number) {
  const gate = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(driveId, 'drive_wallet'), estCostCents: 5 });
  expect(gate).toMatchObject({ allowed: true });
  const [log] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: costDollars }).returning({ id: aiUsageLogs.id });
  expect(await consumeCredits({ aiUsageLogId: log.id, userId: w.marcusId, costDollars, holdId: gate.holdId, walletId: gate.walletId })).toBe('settled');
}

describe('per-consumer caps on drive-wallet and seat legs (orgs on, real Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: wallets.id }).from(wallets).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('consumer-caps.integration.test.ts', error);
      dbAvailable = false;
    }
  });
  beforeEach(() => { process.env.DEPLOYMENT_MODE = 'cloud'; });
  afterEach(async () => {
    afterResolution.run = null;
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    if (world) await teardown(world);
    world = null;
  });
  afterAll(async () => { await pool.end(); });

  it('WAL-7 (partial) on an ORG drive an Owner or Admin writes a member\'s caps; the drive lead, the member and a token cannot', async () => {
    if (!dbAvailable) return;
    world = await build();
    const w = world;

    expect(await setDriveWalletCap(w.anaId, w.productId, w.marcusId, { dailyCents: 30 }, 'session')).toMatchObject({
      ok: true,
      walletId: w.productWalletId,
      caps: [{ userId: w.marcusId, displayName: 'Marcus Oyelaran', dailyCapCents: 30, monthlyCapCents: 1_000, dailyCapCredits: '30', monthlyCapCredits: '1,000' }],
    });
    expect(await capRow(w.productWalletId, w.marcusId)).toMatchObject({ dailyCapCents: 30, monthlyCapCents: 1_000 });

    expect(await setDriveWalletCap(w.lenaId, w.productId, w.marcusId, { dailyCents: 999 }, 'session')).toMatchObject({ ok: false, status: 403, code: 'insufficient_role' });
    expect(await setDriveWalletCap(w.marcusId, w.productId, w.marcusId, { dailyCents: 999 }, 'session')).toMatchObject({ ok: false, status: 403 });
    expect(await setDriveWalletCap(w.jonoId, w.productId, w.marcusId, { dailyCents: 999 }, 'mcp')).toMatchObject({ ok: false, status: 403, code: 'mcp_token_cannot_move_money' });
    expect(await capRow(w.productWalletId, w.marcusId)).toMatchObject({ dailyCapCents: 30 });

    // The lead reads them (spend by member is theirs); a member does not.
    expect(await listDriveWalletCaps(w.lenaId, w.productId, 'session')).toMatchObject({ ok: true, caps: [{ userId: w.marcusId }] });
    expect(await listDriveWalletCaps(w.marcusId, w.productId, 'session')).toMatchObject({ ok: false, status: 403 });

    // Clearing restores "no cap" (unlimited within the wallet).
    expect(await setDriveWalletCap(w.jonoId, w.productId, w.marcusId, null, 'session')).toMatchObject({ ok: true, caps: [] });
    expect(await capRow(w.productWalletId, w.marcusId)).toBeNull();
  });

  it('WAL-7 (partial) on a PERSONAL drive the wallet\'s owner writes caps; the member cannot, and a non-member is no consumer', async () => {
    if (!dbAvailable) return;
    world = await build();
    const w = world;
    expect(await setDriveWalletCap(w.jonoId, w.sideId, w.marcusId, {}, 'session')).toMatchObject({ ok: true, caps: [{ dailyCapCents: 50, monthlyCapCents: 1_000 }] });
    expect(await setDriveWalletCap(w.marcusId, w.sideId, w.marcusId, { dailyCents: null }, 'session')).toMatchObject({ ok: false, status: 403 });
    expect(await setDriveWalletCap(w.jonoId, w.sideId, w.anaId, {}, 'session')).toMatchObject({ ok: false, status: 404, code: 'not_a_consumer' });
    expect(await setDriveWalletCap(w.jonoId, w.sideId, w.marcusId, { dailyCents: -1 }, 'session')).toMatchObject({ ok: false, status: 400, code: 'invalid_amount' });
  });

  it('WAL-7 (partial) a seat cap on the org pool is the Owner\'s or an Admin\'s to write, for an accepted member only', async () => {
    if (!dbAvailable) return;
    world = await build();
    const w = world;
    expect(await setSeatCap(w.jonoId, w.orgId, w.marcusId, { dailyCents: 50, monthlyCents: 2_000 })).toMatchObject({ ok: true, walletId: w.poolId });
    expect(await capRow(w.poolId, w.marcusId)).toMatchObject({ dailyCapCents: 50, monthlyCapCents: 2_000 });
    expect(await setSeatCap(w.lenaId, w.orgId, w.marcusId, { dailyCents: 1 })).toMatchObject({ ok: false, status: 403, code: 'insufficient_role' });
    expect(await setSeatCap(w.anaId, w.orgId, w.sideId, { dailyCents: 1 })).toMatchObject({ ok: false, status: 404, code: 'not_org_member' });
    const outsider = await factories.createUser({ name: 'Outsider' });
    w.userIds.push(outsider.id);
    expect(await setSeatCap(outsider.id, w.orgId, w.marcusId, { dailyCents: 1 })).toMatchObject({ ok: false, status: 404, code: 'org_not_found' });
    expect(await capRow(w.poolId, w.marcusId)).toMatchObject({ dailyCapCents: 50 });
  });

  it('WAL-7 (partial) a cap binds the drive-wallet leg: past it the wallet is refused by name and nothing is reserved, while the wallet still holds money', async () => {
    if (!dbAvailable) return;
    world = await build();
    const w = world;
    await setDriveWalletCap(w.anaId, w.productId, w.marcusId, { dailyCents: 30, monthlyCents: null }, 'session');
    await settledCall(w, w.productId, 0.2); // 30¢: the whole day's cap

    const refused = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: 5 });
    expect(refused).toEqual({ allowed: false, reason: 'source_refused', refusal: { source: 'drive_wallet', reason: 'source_cap_reached', options: ['seat_allowance', 'own_credits'] } });
    expect(await db.select().from(creditHolds).where(eq(creditHolds.userId, w.marcusId))).toEqual([]);
    // Another member with no cap still spends the same wallet.
    await factories.createDriveMember(w.productId, w.anaId, { source: 'org' });
    expect(await canConsumeAI(w.anaId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: 5 })).toMatchObject({ allowed: true, walletId: w.productWalletId });
  });

  it('WAL-7 (partial) a channel @mention a capped member sends is the member spending: refused source_cap_reached once their cap is spent, holding nothing', async () => {
    if (!dbAvailable) return;
    world = await build();
    const w = world;
    await setDriveWalletCap(w.anaId, w.productId, w.marcusId, { dailyCents: 30, monthlyCents: null }, 'session');
    await settledCall(w, w.productId, 0.2); // 30¢: the day's cap is spent

    const mention = await canConsumeAI(w.marcusId, 'free', { spend: personTriggeredSpend(w.productId), estCostCents: 5 });
    expect(mention).toMatchObject({ allowed: false, reason: 'source_refused', refusal: { source: 'drive_wallet', reason: 'source_cap_reached' } });
    expect(await db.select().from(creditHolds).where(eq(creditHolds.userId, w.marcusId))).toEqual([]);

    // SPEND-6 stands for a run no person is present for (a cron, a trigger, a scheduled workflow):
    // it is the drive spending, recorded under its creator, and no person's cap applies.
    const unattended = await canConsumeAI(w.marcusId, 'free', { spend: automationSpend(w.productId), estCostCents: 5 });
    expect(unattended).toMatchObject({ allowed: true, walletId: w.productWalletId });
  });

  it('WAL-7 (partial) ten SIMULTANEOUS calls against a cap with room for one: the wallet lock serializes them, exactly one is admitted', async () => {
    if (!dbAvailable) return;
    world = await build();
    const w = world;
    await setDriveWalletCap(w.anaId, w.productId, w.marcusId, { dailyCents: 5, monthlyCents: null }, 'session');
    for (let run = 0; run < 3; run += 1) {
      const gates = await Promise.all(Array.from({ length: 10 }, () =>
        canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: 5, maxInFlight: 50 })));
      expect(gates.filter((g) => g.allowed)).toHaveLength(1);
      expect(gates.filter((g) => !g.allowed).every((g) => g.refusal?.reason === 'source_cap_reached')).toBe(true);
      await db.delete(creditHolds).where(eq(creditHolds.userId, w.marcusId));
    }
  });

  it('WAL-7 (partial) the cap is decided under the wallet lock: spend landing after the unlocked resolution saw room is still refused, reserving nothing', async () => {
    if (!dbAvailable) return;
    world = await build();
    const w = world;
    await setDriveWalletCap(w.anaId, w.productId, w.marcusId, { dailyCents: 30, monthlyCents: null }, 'session');
    afterResolution.run = async () => {
      await db.insert(creditLedger).values({ userId: w.marcusId, walletId: w.productWalletId, entryType: 'usage', bucket: 'monthly', amountCents: -30, appliedCents: -30, chargeMillicents: 30_000, consumeStatus: 'applied' });
    };
    const gate = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: 5 });
    expect(gate).toEqual({ allowed: false, reason: 'source_refused', refusal: { source: 'drive_wallet', reason: 'source_cap_reached', options: [] } });
    expect(await db.select().from(creditHolds).where(eq(creditHolds.userId, w.marcusId))).toEqual([]);
  });

  it('WAL-7 (partial) the funder is alerted in-app at 80% and at 100%, each exactly once per window per period — never the consumer', async () => {
    if (!dbAvailable) return;
    world = await build();
    const w = world;
    await setDriveWalletCap(w.anaId, w.productId, w.marcusId, { dailyCents: 100, monthlyCents: null }, 'session');

    await settledCall(w, w.productId, 0.3); // 45¢: below 80%
    expect(await capAlertsFor(w.jonoId)).toHaveLength(0);
    await settledCall(w, w.productId, 0.3); // 90¢: 80%
    await settledCall(w, w.productId, 0.02); // 93¢: still past 80%, nothing new
    const at80 = await capAlertsFor(w.jonoId);
    expect(at80.map((n) => n.title)).toEqual(['A spending cap is at 80%']);
    expect(at80[0].message).toContain('Marcus Oyelaran has used 80% of their daily cap in Product');
    expect(at80[0].message).not.toContain('$');
    expect((await capAlertsFor(w.anaId)).length).toBe(1);
    expect(await capAlertsFor(w.marcusId)).toHaveLength(0);
    expect(await capAlertsFor(w.lenaId)).toHaveLength(0);

    // Settles racing past 100% together still send it once.
    await db.insert(creditLedger).values({ userId: w.marcusId, walletId: w.productWalletId, entryType: 'usage', bucket: 'monthly', amountCents: -10, appliedCents: -10, chargeMillicents: 10_000, consumeStatus: 'applied' });
    const sent = await Promise.all([1, 2, 3].map(() => notifyCapAlerts({ walletId: w.productWalletId, userId: w.marcusId })));
    expect(sent.reduce((a, b) => a + b, 0)).toBe(1);
    expect((await capAlertsFor(w.jonoId)).map((n) => n.title).sort()).toEqual(['A spending cap is at 80%', 'A spending cap was reached']);
    expect(await notifyCapAlerts({ walletId: w.productWalletId, userId: w.marcusId })).toBe(0);
  });

  it('X-4 (partial) a settle on a drive wallet announces wallet:changed to the drive room, with no amount; a cap write announces caps', async () => {
    if (!dbAvailable) return;
    world = await build();
    const w = world;
    const sent: { channelId: string; event: string; payload: Record<string, unknown> }[] = [];
    const prevUrl = process.env.INTERNAL_REALTIME_URL;
    process.env.INTERNAL_REALTIME_URL = 'http://realtime.test';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      sent.push(JSON.parse(String((init as RequestInit).body)));
      return new Response('{}', { status: 200 });
    });
    try {
      await settledCall(w, w.productId, 0.02);
      await setDriveWalletCap(w.anaId, w.productId, w.marcusId, { dailyCents: 500 }, 'session');
      await vi.waitFor(() => expect(sent.filter((m) => m.event === 'wallet:changed').length).toBeGreaterThanOrEqual(2));
      const walletEvents = sent.filter((m) => m.event === 'wallet:changed');
      expect(walletEvents.map((m) => [m.channelId, m.payload.change])).toEqual(expect.arrayContaining([
        [`drive:${w.productId}`, 'balance'],
        [`drive:${w.productId}`, 'caps'],
      ]));
      expect(JSON.stringify(walletEvents)).not.toMatch(/Cents|Credits/);
    } finally {
      fetchSpy.mockRestore();
      if (prevUrl === undefined) delete process.env.INTERNAL_REALTIME_URL;
      else process.env.INTERNAL_REALTIME_URL = prevUrl;
    }
  });

  it('WAL-7 (partial) a new period re-arms the alert: the same threshold tomorrow is sent again', async () => {
    if (!dbAvailable) return;
    world = await build();
    const w = world;
    await setDriveWalletCap(w.jonoId, w.sideId, w.marcusId, { dailyCents: 10, monthlyCents: null }, 'session');
    await settledCall(w, w.sideId, 0.1); // 15¢ ≥ 10¢: 80% and 100%
    expect(await capAlertsFor(w.jonoId)).toHaveLength(2);
    // The same spend seen from tomorrow is a new day's window with nothing spent in it.
    const tomorrow = new Date(Date.now() + 86_400_000);
    expect(await notifyCapAlerts({ walletId: w.sideWalletId, userId: w.marcusId, now: tomorrow })).toBe(0);
    await db.insert(creditLedger).values({ userId: w.marcusId, walletId: w.sideWalletId, entryType: 'usage', bucket: 'monthly', amountCents: -10, appliedCents: -10, chargeMillicents: 10_000, consumeStatus: 'applied', createdAt: tomorrow });
    expect(await notifyCapAlerts({ walletId: w.sideWalletId, userId: w.marcusId, now: tomorrow })).toBe(2);
  });
});
