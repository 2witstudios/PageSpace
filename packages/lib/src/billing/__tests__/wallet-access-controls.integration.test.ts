/**
 * Who may spend and fund a drive wallet, what a consumer sees of it, and the controls that stop it,
 * against a real Postgres (Spec WAL-1, WAL-4, WAL-7, SPEND-6, SPEND-9; decisions D-OW-4, D-OW-5,
 * D-OW-13, D-OW-31).
 *
 * Northwind (Sequence Spec fixture): Jono owns the org, Ana is an Admin, Marcus a member, Lena a
 * member who leads Product (an Open org drive). Chris Rowe is a GUEST on Product (a drive member
 * outside the org); Dana is an outsider with no access. Jono's personal drive Side Project has a
 * wallet his personal root funds; Marcus is a member there.
 *
 * Requires DATABASE_URL → a migrated Postgres; fails loudly without one (requireDb).
 * Deletes every row it creates, children before parents, users last, and ends the pool.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { notifications } from '@pagespace/db/schema/notifications';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { automationSkipNotices, walletCapAlerts, walletConsumerCaps, walletFundingLegs, wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { canConsumeAI } from '../credit-gate';
import { consumeCredits, releaseHold } from '../credit-consume';
import { getCreditBalance } from '../credit-balance';
import { automationSpend, driveSpend, personTriggeredSpend } from '../spend-target';
import { listSpendChoices } from '../spend-resolution';
import { centsFromCredits } from '../money-model';
import { DEFAULT_CONSUMER_CAPS } from '../wallet-core';
import { CONSUMER_WALLET_FIELDS } from '../wallet-views';
import { refundFundingLeg, resetDueAllocations } from '../wallet-funding-shell';
import { walletDriftAlerts } from '../wallet-reconcile';
import { moveDriveOutOfOrg, moveDriveToOrg, type OrgDriveServiceDeps } from '../../services/org-drive-service';
import type { OrgRole } from '@pagespace/db/schema/organizations';
import { credentialActor } from '../../permissions/access-actor';
import {
  donateToDrive,
  getDriveSpend,
  getDriveWallet,
  getOrgPoolSplit,
  listDriveWalletCaps,
  listMyWallets,
  setDriveWalletCap,
  setOrgPoolPaused,
  setSeatCap,
  updateDriveWallet,
} from '../../services/drive-wallet-service';

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
const DAY = 86_400_000;
const POOL_CENTS = 50_000;
const PRODUCT_ALLOCATION = 10_000;
const SIDE_ALLOCATION = 1_000;

interface World {
  orgId: string;
  productId: string;
  sideId: string;
  agentPageId: string;
  jonoId: string;
  anaId: string;
  marcusId: string;
  lenaId: string;
  chrisId: string;
  danaId: string;
  poolId: string;
  productWalletId: string;
  sideWalletId: string;
  jonoRootId: string;
  userIds: string[];
}
let world: World | null = null;

async function build(): Promise<World> {
  const [jono, ana, marcus, lena, chris, dana] = await Promise.all([
    factories.createUser({ name: 'Jono', subscriptionTier: 'pro' }),
    factories.createUser({ name: 'Ana Admin', subscriptionTier: 'free' }),
    factories.createUser({ name: 'Marcus Oyelaran', subscriptionTier: 'free' }),
    factories.createUser({ name: 'Lena Lead', subscriptionTier: 'free' }),
    factories.createUser({ name: 'Chris Rowe', subscriptionTier: 'free' }),
    factories.createUser({ name: 'Dana Outsider', subscriptionTier: 'free' }),
  ]);
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: jono.id, stripeCustomerId: `cus_${createId()}` }).returning();
  await factories.createOrgSubscription(org.id);
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: jono.id, role: 'OWNER' },
    { orgId: org.id, userId: ana.id, role: 'ADMIN' },
    { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
    { orgId: org.id, userId: lena.id, role: 'MEMBER' },
  ]);
  const product = await factories.createDrive(lena.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  await factories.createDriveMember(product.id, marcus.id, { source: 'org' });
  await factories.createDriveMember(product.id, chris.id, { source: 'invite' });
  const agentPage = await factories.createPage(product.id, { title: 'Research agent', type: 'AI_CHAT' });
  const now = Date.now();
  const [poolWallet] = await db.insert(wallets).values({
    ownerType: 'org', orgId: org.id, monthlyRemainingCents: POOL_CENTS,
    monthlyPeriodStart: new Date(now - 10 * DAY), monthlyPeriodEnd: new Date(now + 20 * DAY),
  }).returning();
  const [productWallet] = await db.insert(wallets).values({
    ownerType: 'org', orgId: org.id, subjectType: 'drive', subjectId: product.id, parentWalletId: poolWallet.id,
    monthlyAllowanceCents: PRODUCT_ALLOCATION, monthlyPeriodStart: new Date(now - 10 * DAY), monthlyPeriodEnd: new Date(now + 20 * DAY),
  }).returning();
  const [jonoRoot] = await db.insert(wallets).values({ userId: jono.id, monthlyRemainingCents: 9_000, monthlyPeriodStart: new Date(now - DAY), monthlyPeriodEnd: new Date(now + 20 * DAY) }).returning();
  // Everyone else holds their own credits, so a donation or a fallback has a balance to draw.
  await db.insert(wallets).values([marcus, lena, chris, dana, ana].map((u) => ({ userId: u.id, monthlyRemainingCents: 5_000, monthlyPeriodStart: new Date(now - DAY), monthlyPeriodEnd: new Date(now + 20 * DAY) })));
  const side = await factories.createDrive(jono.id, { name: 'Side Project', slug: `side-${createId()}` });
  await factories.createDriveMember(side.id, marcus.id, { source: 'invite' });
  const [sideWallet] = await db.insert(wallets).values({ userId: jono.id, subjectType: 'drive', subjectId: side.id, parentWalletId: jonoRoot.id, monthlyAllowanceCents: SIDE_ALLOCATION }).returning();
  return {
    orgId: org.id, productId: product.id, sideId: side.id, agentPageId: agentPage.id,
    jonoId: jono.id, anaId: ana.id, marcusId: marcus.id, lenaId: lena.id, chrisId: chris.id, danaId: dana.id,
    poolId: poolWallet.id, productWalletId: productWallet.id, sideWalletId: sideWallet.id, jonoRootId: jonoRoot.id,
    userIds: [jono.id, ana.id, marcus.id, lena.id, chris.id, dana.id],
  };
}

async function teardown(w: World): Promise<void> {
  const walletIds = (await db.select({ id: wallets.id }).from(wallets).where(sql`${wallets.orgId} = ${w.orgId} OR ${inArray(wallets.userId, w.userIds)}`)).map((r) => r.id);
  await db.delete(notifications).where(inArray(notifications.userId, w.userIds));
  await db.delete(automationSkipNotices).where(inArray(automationSkipNotices.driveId, [w.productId, w.sideId]));
  await db.delete(aiUsageLogs).where(inArray(aiUsageLogs.userId, w.userIds));
  await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
  if (walletIds.length > 0) {
    // Funding legs cascade with their wallet (deleting them first would trip the leg-sum invariant).
    await db.delete(walletCapAlerts).where(inArray(walletCapAlerts.walletId, walletIds));
    await db.delete(walletConsumerCaps).where(inArray(walletConsumerCaps.walletId, walletIds));
    await db.delete(wallets).where(and(inArray(wallets.id, walletIds), sql`${wallets.parentWalletId} IS NOT NULL`));
    await db.delete(wallets).where(inArray(wallets.id, walletIds));
  }
  await db.delete(pages).where(eq(pages.id, w.agentPageId));
  await db.delete(drives).where(inArray(drives.id, [w.productId, w.sideId]));
  await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, w.orgId));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

const walletRow = async (id: string) => (await db.select().from(wallets).where(eq(wallets.id, id)))[0];
const liveHolds = async (userId: string) => db.select().from(creditHolds).where(eq(creditHolds.userId, userId));
const notificationsOf = (userId: string, type: string) =>
  db.select().from(notifications).where(and(eq(notifications.userId, userId), sql`${notifications.type} = ${type}`));

/** A settled call by `userId` on Product's wallet costing `costDollars` (1.5x markup: $0.10 → 15¢). */
async function settledCall(w: World, userId: string, costDollars: number): Promise<void> {
  const gate = await canConsumeAI(userId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: 5 });
  expect(gate).toMatchObject({ allowed: true, walletId: w.productWalletId });
  const [log] = await db.insert(aiUsageLogs).values({ userId, provider: 'openrouter', model: 'm', cost: costDollars }).returning({ id: aiUsageLogs.id });
  expect(await consumeCredits({ aiUsageLogId: log.id, userId, costDollars, holdId: gate.holdId, walletId: gate.walletId })).toBe('settled');
}

const credits = (n: number): number => Math.round(centsFromCredits(n));

const moveDeps: OrgDriveServiceDeps = {
  getOrgRole: async (tx, orgId, userId) => {
    const [row] = await tx.select({ role: orgMembers.role }).from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
    return (row?.role ?? null) as OrgRole | null;
  },
  syncOrgMembership: async () => async () => {},
  getOrgDriveCreationPolicy: async () => 'members',
};

describe('wallet access, visibility and controls (real Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: wallets.id }).from(wallets).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('wallet-access-controls.integration.test.ts', error);
      dbAvailable = false;
    }
    process.env.DEPLOYMENT_MODE = 'cloud';
  });

  beforeEach(async () => {
    if (!dbAvailable) return;
    world = await build();
  });

  afterEach(async () => {
    afterResolution.run = null;
    if (world) await teardown(world);
    world = null;
  });

  afterAll(async () => {
    process.env.DEPLOYMENT_MODE = originalMode;
    await pool.end();
  });

  describe('WAL-1 one wallets table holds every balance: a personal root (the per-user balance), an org pool and a drive wallet — a drive the only subject (D-OW-59) — each with owner, optional subject, optional parent, monthly allocation, spent, top-up remainder, UTC period and status; a top-up never expires across an allocation reset', () => {
    it('every wallet shape is a row of one table, and the per-user balance reads the personal root wallet', async () => {
      const w = world as World;
      // There is no second balance store: credit_balances is gone, renamed in place into wallets (X-5).
      const [legacy] = (await db.execute(sql`SELECT to_regclass('public.credit_balances') AS t`)).rows as { t: string | null }[];
      expect(legacy.t).toBeNull();

      const shapes = await db
        .select({ id: wallets.id, ownerType: wallets.ownerType, userId: wallets.userId, orgId: wallets.orgId, subjectType: wallets.subjectType, subjectId: wallets.subjectId, parentWalletId: wallets.parentWalletId, status: wallets.status })
        .from(wallets)
        .where(inArray(wallets.id, [w.jonoRootId, w.poolId, w.productWalletId]));
      const byId = new Map(shapes.map((s) => [s.id, s]));
      expect(byId.get(w.jonoRootId)).toMatchObject({ ownerType: 'user', userId: w.jonoId, orgId: null, subjectType: null, parentWalletId: null, status: 'active' });
      expect(byId.get(w.poolId)).toMatchObject({ ownerType: 'org', orgId: w.orgId, userId: null, subjectType: null, parentWalletId: null });
      expect(byId.get(w.productWalletId)).toMatchObject({ ownerType: 'org', subjectType: 'drive', subjectId: w.productId, parentWalletId: w.poolId });
      // A drive is the only subject: an agent page (or anything else) is refused by the table (D-OW-59).
      await expect(db.insert(wallets).values({
        ownerType: 'org', orgId: w.orgId, subjectType: 'agent_page' as 'drive', subjectId: w.agentPageId, parentWalletId: w.productWalletId,
      })).rejects.toThrow();
      // Status is one of three; anything else is refused by the table.
      await expect(db.update(wallets).set({ status: 'frozen' as 'paused' }).where(eq(wallets.id, w.poolId))).rejects.toThrow();

      // The per-user balance IS the personal root wallet: Jono's 9,000 cents, not the drive wallet he owns.
      expect(await getCreditBalance(w.jonoId, 'pro')).toMatchObject({ monthly: { remaining: 9_000 } });
    });

    it('a drive wallet\'s top-up survives its allocation reset; spent returns to zero and the period moves to the parent\'s', async () => {
      const w = world as World;
      const now = new Date();
      await db.update(wallets).set({ spentCents: 4_000, monthlyPeriodStart: new Date(now.getTime() - 40 * DAY), monthlyPeriodEnd: new Date(now.getTime() - 11 * DAY) }).where(eq(wallets.id, w.productWalletId));
      expect(await donateToDrive(credentialActor(w.marcusId, null), w.productId, { amountCents: 700, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: true });

      const swept = await resetDueAllocations({ now });
      expect(swept.failed).toBe(0);
      const after = await walletRow(w.productWalletId);
      const pool = await walletRow(w.poolId);
      expect(after).toMatchObject({ spentCents: 0, topupRemainingCents: 700, monthlyAllowanceCents: PRODUCT_ALLOCATION });
      expect(after.monthlyPeriodStart?.getTime()).toBe(pool.monthlyPeriodStart?.getTime());
      const [legs] = (await db.execute(sql`SELECT coalesce(sum("remainingCents"), 0)::int AS cents FROM wallet_funding_legs WHERE "walletId" = ${w.productWalletId}`)).rows as { cents: number }[];
      expect(legs.cents).toBe(700);
    });
  });

  describe('WAL-4 any authenticated user who can see a drive — a guest included — donates a one-off amount from their own balance as a funder leg recorded with them; the lead turns donations off for the drive; a donation is never refundable and never pays the wallet\'s debt (D-OW-13)', () => {
    it('a guest donates from their own root: one leg with them as funder, a replay lands once, a non-viewer is refused', async () => {
      const w = world as World;
      const chrisRootBefore = (await db.select().from(wallets).where(and(eq(wallets.userId, w.chrisId), sql`${wallets.subjectType} IS NULL`)))[0];
      const key = createId();
      const donated = await donateToDrive(credentialActor(w.chrisId, null), w.productId, { amountCents: 500, idempotencyKey: key }, 'session');
      expect(donated).toMatchObject({ ok: true, amountCents: 500, duplicate: false });
      expect(await donateToDrive(credentialActor(w.chrisId, null), w.productId, { amountCents: 500, idempotencyKey: key }, 'session')).toMatchObject({ ok: true, duplicate: true });

      const chrisRootAfter = await walletRow(chrisRootBefore.id);
      expect(chrisRootAfter.monthlyRemainingCents + chrisRootAfter.topupRemainingCents).toBe(chrisRootBefore.monthlyRemainingCents + chrisRootBefore.topupRemainingCents - 500);
      const legs = await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, w.productWalletId));
      expect(legs).toHaveLength(1);
      expect(legs[0]).toMatchObject({ funderKind: 'donation', funderUserId: w.chrisId, originalCents: 500, remainingCents: 500, nonRefundable: true });
      expect((await walletRow(w.productWalletId)).topupRemainingCents).toBe(500);

      // Dana cannot see Product: refused as if it were not there, and nothing moves.
      expect(await donateToDrive(credentialActor(w.danaId, null), w.productId, { amountCents: 100, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: false, status: 404 });
      expect((await walletRow(w.productWalletId)).topupRemainingCents).toBe(500);
    });

    it('the drive lead turns donations off and the same donor is refused with nothing moved; a donation leg is never refunded', async () => {
      const w = world as World;
      const donated = await donateToDrive(credentialActor(w.marcusId, null), w.productId, { amountCents: 300, idempotencyKey: createId() }, 'session');
      expect(donated).toMatchObject({ ok: true });
      expect(await updateDriveWallet(credentialActor(w.lenaId, null), w.productId, { donationsEnabled: false }, 'session')).toMatchObject({ ok: true });
      const before = await walletRow(w.productWalletId);
      expect(await donateToDrive(credentialActor(w.marcusId, null), w.productId, { amountCents: 300, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: false, status: 409, code: 'donations_disabled' });
      expect((await walletRow(w.productWalletId)).topupRemainingCents).toBe(before.topupRemainingCents);

      const [leg] = await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, w.productWalletId));
      expect(await refundFundingLeg(leg.id, 100)).toMatchObject({ kind: 'refuse' });
      expect((await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.id, leg.id)))[0].remainingCents).toBe(300);
    });

    it('a donation to a wallet carrying debt is the donor\'s whole leg; the debt stays for the funder\'s next allocation', async () => {
      const w = world as World;
      await db.update(wallets).set({ debtCents: 300 }).where(eq(wallets.id, w.productWalletId));
      expect(await donateToDrive(credentialActor(w.marcusId, null), w.productId, { amountCents: 200, idempotencyKey: createId() }, 'session')).toMatchObject({ ok: true, amountCents: 200 });
      expect(await walletRow(w.productWalletId)).toMatchObject({ debtCents: 300, topupRemainingCents: 200 });
      const [leg] = await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, w.productWalletId));
      expect(leg).toMatchObject({ originalCents: 200, remainingCents: 200, funderUserId: w.marcusId });
    });
  });

  describe('WAL-7 per-consumer caps (daily and monthly, UTC) on every wallet leg — unset is unlimited, enabling takes the D-OW-31 defaults (5 credits a day, 100 a month) — alert the funder once at 80% and 100%, and a kill switch pauses a wallet: a drive wallet, or the org pool and everything it funds', () => {
    it('enabling caps with nothing named stores 5 credits a day and 100 a month; a window set to null, and a person with no row, are unlimited', async () => {
      const w = world as World;
      expect(DEFAULT_CONSUMER_CAPS).toEqual({ dailyCents: credits(5), monthlyCents: credits(100) });
      expect(await setDriveWalletCap(credentialActor(w.anaId, null), w.productId, w.marcusId, {}, 'session')).toMatchObject({ ok: true });
      expect(await listDriveWalletCaps(credentialActor(w.anaId, null), w.productId, 'session')).toMatchObject({
        ok: true,
        caps: [{ userId: w.marcusId, dailyCapCents: credits(5), monthlyCapCents: credits(100) }],
      });
      await setDriveWalletCap(credentialActor(w.anaId, null), w.productId, w.marcusId, { monthlyCents: null }, 'session');
      const read = await getDriveWallet(credentialActor(w.marcusId, null), w.productId, 'session');
      expect(read.ok && read.wallet && 'myCap' in read.wallet ? read.wallet.myCap : null).toMatchObject({ dailyRemainingCents: credits(5), monthlyRemainingCents: null });
      // Lena has no cap row: unlimited within the wallet, so a call far past Marcus's daily cap passes.
      expect(await canConsumeAI(w.lenaId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: credits(6) })).toMatchObject({ allowed: true });
    });

    it('the gate refuses past the daily and then the monthly UTC window by name, charging nothing; the funders get one 80% and one 100% alert per window', async () => {
      const w = world as World;
      await setDriveWalletCap(credentialActor(w.anaId, null), w.productId, w.marcusId, { dailyCents: 100, monthlyCents: null }, 'session');
      await settledCall(w, w.marcusId, 0.6); // 90¢ of a 100¢ day: 80% reached
      await settledCall(w, w.marcusId, 0.1); // 105¢: 100% reached
      const refused = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: 5 });
      expect(refused).toMatchObject({ allowed: false, refusal: { source: 'drive_wallet', reason: 'source_cap_reached' } });
      expect(await liveHolds(w.marcusId)).toHaveLength(0);

      // The month: the day lifted, a 120¢ month already 105¢ in.
      await setDriveWalletCap(credentialActor(w.anaId, null), w.productId, w.marcusId, { dailyCents: null, monthlyCents: 120 }, 'session');
      await settledCall(w, w.marcusId, 0.1); // 120¢: 80% and 100% of the month
      expect(await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: 5 }))
        .toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });

      for (const funder of [w.jonoId, w.anaId]) {
        const alerts = await notificationsOf(funder, 'WALLET_CAP_ALERT');
        const keys = alerts.map((a) => { const m = a.metadata as { window: string; threshold: number }; return `${m.window}:${m.threshold}`; }).sort();
        expect(keys, funder).toEqual(['daily:100', 'daily:80', 'monthly:100', 'monthly:80']);
      }
      // The consumer is never the one told.
      expect(await notificationsOf(w.marcusId, 'WALLET_CAP_ALERT')).toHaveLength(0);
    });

    it('a seat (the org pool leg) takes a daily cap too, and the gate refuses past it', async () => {
      const w = world as World;
      expect(await setSeatCap(w.anaId, w.orgId, w.marcusId, { dailyCents: 4 })).toMatchObject({ ok: true });
      expect(await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'seat_allowance'), estCostCents: 5 }))
        .toMatchObject({ allowed: false, refusal: { source: 'seat_allowance', reason: 'source_cap_reached' } });
    });

    it('pausing the drive wallet refuses every consumer and skips every automation; resuming restores it', async () => {
      const w = world as World;
      expect(await updateDriveWallet(credentialActor(w.lenaId, null), w.productId, { paused: true }, 'session')).toMatchObject({ ok: true });
      expect(await canConsumeAI(w.lenaId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: 5 }))
        .toMatchObject({ allowed: false, refusal: { reason: 'source_paused' } });
      expect(await canConsumeAI(w.lenaId, 'free', { spend: automationSpend(w.productId), estCostCents: 5, skipDailyCap: true }))
        .toMatchObject({ allowed: false, refusal: { reason: 'drive_wallet_paused' } });
      await updateDriveWallet(credentialActor(w.lenaId, null), w.productId, { paused: false }, 'session');
      expect(await canConsumeAI(w.lenaId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: 5 })).toMatchObject({ allowed: true });
    });

    it('pausing the org pool stops every seat and every drive wallet it funds, at the gate and on every read; a lapsed org may pause but never resume', async () => {
      const w = world as World;
      expect(await setOrgPoolPaused(w.anaId, w.orgId, true)).toEqual({ ok: true, walletId: w.poolId, status: 'paused' });
      expect(await canConsumeAI(w.lenaId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: 5 }))
        .toMatchObject({ allowed: false, refusal: { source: 'drive_wallet', reason: 'source_paused' } });
      expect(await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'seat_allowance'), estCostCents: 5 }))
        .toMatchObject({ allowed: false, refusal: { source: 'seat_allowance', reason: 'source_paused' } });
      expect(await canConsumeAI(w.lenaId, 'free', { spend: automationSpend(w.productId), estCostCents: 5, skipDailyCap: true }))
        .toMatchObject({ allowed: false, refusal: { reason: 'drive_wallet_paused' } });
      // The drive wallet's own row is untouched; it reads paused because its parent is.
      expect((await walletRow(w.productWalletId)).status).toBe('active');
      const memberView = await getDriveWallet(credentialActor(w.marcusId, null), w.productId, 'session');
      expect(memberView.ok && memberView.wallet?.status).toBe('paused');
      const split = await getOrgPoolSplit(w.orgId);
      expect(split.status).toBe('paused');
      expect(split.driveWallets.find((d) => d.walletId === w.productWalletId)?.status).toBe('paused');
      // A personal drive's wallet is no org's: untouched by the pool's switch.
      expect(await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.sideId, 'drive_wallet'), estCostCents: 5 })).toMatchObject({ allowed: true });

      // Lapse (no paid subscription): pausing still applies, resuming is refused and nothing changes.
      await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, w.orgId));
      expect(await setOrgPoolPaused(w.anaId, w.orgId, false)).toMatchObject({ ok: false });
      expect((await walletRow(w.poolId)).status).toBe('paused');
      expect(await setOrgPoolPaused(w.anaId, w.orgId, true)).toMatchObject({ ok: true, status: 'paused' });
      await factories.createOrgSubscription(w.orgId);

      expect(await setOrgPoolPaused(w.anaId, w.orgId, false)).toEqual({ ok: true, walletId: w.poolId, status: 'active' });
      expect(await canConsumeAI(w.lenaId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: 5 })).toMatchObject({ allowed: true });
    });
  });

  describe('WAL-7 (partial) the gate decides the kill switch on the locked rows', () => {
    it('WAL-7 (partial) a pool paused between resolution and the hold still refuses its drive wallet, charging nothing', async () => {
      const w = world as World;
      afterResolution.run = async () => {
        await db.update(wallets).set({ status: 'paused' }).where(eq(wallets.id, w.poolId));
      };
      expect(await canConsumeAI(w.lenaId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: 5 }))
        .toMatchObject({ allowed: false, refusal: { source: 'drive_wallet', reason: 'source_paused' } });
      expect(await liveHolds(w.lenaId)).toHaveLength(0);
    });
  });

  describe('SPEND-9 consumers see the drive wallet\'s remaining amount and their own remaining cap — never the org pool, never the funder\'s balance, never other consumers\' spend', () => {
    it('with the pool and the funder\'s personal wallet below the allocation, every consumer surface shows the wallet\'s own remaining, never either parent\'s balance', async () => {
      const w = world as World;
      // The pool holds 700¢ against a 10,000¢ allocation; Jono's root 300¢ against Side Project's 1,000¢.
      await db.update(wallets).set({ monthlyRemainingCents: 700 }).where(eq(wallets.id, w.poolId));
      await db.update(wallets).set({ monthlyRemainingCents: 300 }).where(eq(wallets.id, w.jonoRootId));
      await settledCall(w, w.lenaId, 0.2); // Lena spent 30¢ of Product: another consumer's spend

      const productLeft = PRODUCT_ALLOCATION - 30;
      // The drive wallet read, in a session and through a token (D-OW-26): the consumer allowlist only.
      for (const [who, credential] of [[w.marcusId, 'session'], [w.lenaId, 'mcp']] as const) {
        const read = await getDriveWallet(credentialActor(who, null), w.productId, credential);
        expect(read.ok && read.wallet ? Object.keys(read.wallet).sort() : null, who).toEqual([...CONSUMER_WALLET_FIELDS].sort());
        expect(read.ok && read.wallet ? read.wallet.remainingCents : null).toBe(productLeft);
      }
      // My wallets, the conversation/drive spend options (the chip, strip and popover).
      const mine = await listMyWallets(credentialActor(w.marcusId, null), 'session');
      expect(mine.driveWallets.find((d) => d.walletId === w.productWalletId)?.remainingCents).toBe(productLeft);
      expect(mine.driveWallets.find((d) => d.walletId === w.sideWalletId)?.remainingCents).toBe(SIDE_ALLOCATION);
      expect(mine.funds.pools).toEqual([]);
      const productChoice = (await listSpendChoices(w.marcusId, w.productId)).find((c) => c.source === 'drive_wallet');
      expect(productChoice).toMatchObject({ walletId: w.productWalletId, remainingCents: productLeft });
      const sideChoice = (await listSpendChoices(w.marcusId, w.sideId)).find((c) => c.source === 'drive_wallet');
      expect(sideChoice).toMatchObject({ walletId: w.sideWalletId, remainingCents: SIDE_ALLOCATION });
      const driveSpendRead = await getDriveSpend(credentialActor(w.marcusId, null), w.productId);
      expect(driveSpendRead.ok ? driveSpendRead.options.find((o) => o.source === 'drive_wallet')?.remainingCents : null).toBe(productLeft);
      // Neither parent's figure appears anywhere a consumer reads.
      const everything = JSON.stringify([mine, productChoice, sideChoice, driveSpendRead, await getDriveWallet(credentialActor(w.marcusId, null), w.productId, 'session')]);
      for (const leaked of ['"availableCents"', '"unallocatedCents"', '"spendByConsumer"']) expect(everything).not.toContain(leaked);
      expect(everything).not.toMatch(/"remainingCents":(700|300|670)\b/);

      // When the parent cannot cover a call the gate refuses it by name and charges nothing — no number disclosed.
      expect(await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: 800 }))
        .toMatchObject({ allowed: false, refusal: { source: 'drive_wallet', reason: 'source_empty' } });
      expect(await liveHolds(w.marcusId)).toHaveLength(0);
    });

    it('a consumer\'s own remaining cap bounds what they see, and a guest sees the drive wallet only once the drive opens it to guests, bounded by the default caps', async () => {
      const w = world as World;
      await setDriveWalletCap(credentialActor(w.anaId, null), w.productId, w.marcusId, { dailyCents: 40, monthlyCents: null }, 'session');
      expect((await listSpendChoices(w.marcusId, w.productId)).find((c) => c.source === 'drive_wallet')?.remainingCents).toBe(40);

      expect((await listSpendChoices(w.chrisId, w.productId)).map((c) => c.source)).toEqual(['own_credits']);
      expect(await updateDriveWallet(credentialActor(w.anaId, null), w.productId, { guestSpendEnabled: true }, 'session')).toMatchObject({ ok: true });
      const chris = await listSpendChoices(w.chrisId, w.productId);
      expect(chris.map((c) => c.source)).toEqual(['drive_wallet', 'own_credits']);
      expect(chris[0].remainingCents).toBe(credits(5));
      const guestView = await getDriveWallet(credentialActor(w.chrisId, null), w.productId, 'session');
      expect(guestView.ok && guestView.wallet && 'myCap' in guestView.wallet ? guestView.wallet.myCap : null)
        .toMatchObject({ dailyRemainingCents: credits(5), monthlyRemainingCents: credits(100) });
    });
  });

  describe('D-OW-60: a drive move re-homes its wallet, guest standing follows the drive, debt never nets a donation', () => {
    it('SPEND-6 (partial) WAL-2 (partial) a drive moved INTO the org: its wallet is the org\'s under the pool, and a guest spends it only with the switch on, always capped', async () => {
      const w = world as World;
      // Side's wallet carries 150¢ of wallet debt (WAL-6c), landed as an overshoot debt row would land it.
      await db.update(wallets).set({ spentCents: 200, debtCents: 150, status: 'over', topupRemainingCents: 0 }).where(eq(wallets.id, w.sideWalletId));
      await db.insert(creditLedger).values({ userId: w.jonoId, walletId: w.sideWalletId, entryType: 'adjustment', bucket: 'monthly', amountCents: -150, consumeStatus: 'applied' });
      expect(await walletDriftAlerts({ toleranceCents: 0, limit: 10, walletIds: [w.sideWalletId] })).toEqual([]);
      expect(await moveDriveToOrg(w.jonoId, w.sideId, { credential: 'session', orgId: w.orgId }, moveDeps)).toMatchObject({ ok: true });

      // Same row: the org's now, under its pool; the old funder's allocation and debt stayed behind (forgiven, ledgered).
      expect(await walletRow(w.sideWalletId)).toMatchObject({ ownerType: 'org', orgId: w.orgId, userId: null, parentWalletId: w.poolId, monthlyAllowanceCents: 0, spentCents: 0, debtCents: 0, status: 'active' });
      expect(await walletDriftAlerts({ toleranceCents: 0, limit: 10, walletIds: [w.sideWalletId] })).toEqual([]);
      expect(await updateDriveWallet(credentialActor(w.anaId, null), w.sideId, { allocationCents: 2_000 }, 'session')).toMatchObject({ ok: true });
      // Chris, outside Northwind, is invited onto the moved drive: a guest of it now.
      await factories.createDriveMember(w.sideId, w.chrisId, { source: 'invite' });

      // Chris is a guest now: refused while the switch is off, capped at the default when it is on.
      expect(await canConsumeAI(w.chrisId, 'free', { spend: driveSpend(w.sideId, 'drive_wallet'), estCostCents: 5 }))
        .toMatchObject({ allowed: false, refusal: { reason: 'guest_drive_wallet_off' } });
      expect(await updateDriveWallet(credentialActor(w.anaId, null), w.sideId, { guestSpendEnabled: true }, 'session')).toMatchObject({ ok: true });
      expect(await canConsumeAI(w.chrisId, 'free', { spend: driveSpend(w.sideId, 'drive_wallet'), estCostCents: credits(6) }))
        .toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });
      expect(await canConsumeAI(w.chrisId, 'free', { spend: driveSpend(w.sideId, 'drive_wallet'), estCostCents: 5 }))
        .toMatchObject({ allowed: true, walletId: w.sideWalletId });
      const view = await getDriveWallet(credentialActor(w.chrisId, null), w.sideId, 'session');
      expect(view.ok && view.wallet && 'myCap' in view.wallet ? view.wallet.myCap : null).toMatchObject({ dailyRemainingCents: expect.any(Number), monthlyRemainingCents: expect.any(Number) });
    });

    it('SPEND-6 (partial) WAL-2 (partial) a drive moved OUT of the org: its wallet is the lead\'s under their root, and its members are not guests', async () => {
      const w = world as World;
      await donateToDrive(credentialActor(w.marcusId, null), w.productId, { amountCents: 300, idempotencyKey: createId() }, 'session');
      expect(await moveDriveOutOfOrg(w.jonoId, w.productId, { credential: 'session', implicitMembers: 'keep' }, moveDeps)).toMatchObject({ ok: true });
      const lenaRoot = (await db.select().from(wallets).where(and(eq(wallets.userId, w.lenaId), sql`${wallets.subjectType} IS NULL`)))[0];
      // Same row, the lead's now under their root; the donation leg moved with it.
      expect(await walletRow(w.productWalletId)).toMatchObject({ ownerType: 'user', userId: w.lenaId, orgId: null, parentWalletId: lenaRoot.id, monthlyAllowanceCents: 0, topupRemainingCents: 300 });
      expect(await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, w.productWalletId))).toHaveLength(1);

      // Chris (outside the former org) is a member of a personal drive now — no guest switch, no guest cap.
      expect(await canConsumeAI(w.chrisId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: credits(6) }))
        .toMatchObject({ allowed: true, walletId: w.productWalletId });
      const view = await getDriveWallet(credentialActor(w.chrisId, null), w.productId, 'session');
      expect(view.ok && view.wallet && 'myCap' in view.wallet ? view.wallet.myCap : null).toMatchObject({ dailyRemainingCents: null, monthlyRemainingCents: null });
    });

    it('WAL-6 (partial) a drive is not moved OUT while a call is in flight on its wallet: Marcus\'s org-authorized call never settles on Lena\'s own credits', async () => {
      const w = world as World;
      const hold = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: 5 });
      expect(hold).toMatchObject({ allowed: true, walletId: w.productWalletId });
      const before = await walletRow(w.productWalletId);

      expect(await moveDriveOutOfOrg(w.jonoId, w.productId, { credential: 'session', implicitMembers: 'keep' }, moveDeps))
        .toMatchObject({ ok: false, code: 'drive_wallet_calls_in_flight', status: 409, message: expect.stringContaining('Try moving the drive again') });
      // Nothing moved: the drive is still the org's, its wallet untouched.
      expect((await db.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, w.productId)))[0].orgId).toBe(w.orgId);
      expect(await walletRow(w.productWalletId)).toMatchObject({ ownerType: 'org', parentWalletId: w.poolId, monthlyAllowanceCents: before.monthlyAllowanceCents });

      // The call settles on the org pool that authorized it; then the move goes through.
      const [log] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: 1 }).returning({ id: aiUsageLogs.id });
      expect(await consumeCredits({ aiUsageLogId: log.id, userId: w.marcusId, costDollars: 1, holdId: hold.allowed ? hold.holdId : undefined, walletId: w.productWalletId })).toBe('settled');
      expect(await moveDriveOutOfOrg(w.jonoId, w.productId, { credential: 'session', implicitMembers: 'keep' }, moveDeps)).toMatchObject({ ok: true });
      const lenaRoot = (await db.select().from(wallets).where(and(eq(wallets.userId, w.lenaId), sql`${wallets.subjectType} IS NULL`)))[0];
      expect(lenaRoot.debtCents).toBe(0);
      expect((await walletRow(w.poolId)).monthlyRemainingCents).toBe(POOL_CENTS - 150);
    });

    it('WAL-6 (partial) a drive is not moved INTO the org while a call is in flight on its wallet: the org pool never pays for a personal call', async () => {
      const w = world as World;
      const hold = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.sideId, 'drive_wallet'), estCostCents: 5 });
      expect(hold).toMatchObject({ allowed: true, walletId: w.sideWalletId });
      expect(await moveDriveToOrg(w.jonoId, w.sideId, { credential: 'session', orgId: w.orgId }, moveDeps)).toMatchObject({ ok: false, code: 'drive_wallet_calls_in_flight' });
      expect((await db.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, w.sideId)))[0].orgId).toBeNull();
      expect(await walletRow(w.sideWalletId)).toMatchObject({ ownerType: 'user', parentWalletId: w.jonoRootId });

      await releaseHold(hold.allowed && hold.holdId ? hold.holdId : '');
      expect(await moveDriveToOrg(w.jonoId, w.sideId, { credential: 'session', orgId: w.orgId }, moveDeps)).toMatchObject({ ok: true });
      expect(await walletRow(w.sideWalletId)).toMatchObject({ ownerType: 'org', parentWalletId: w.poolId });
    });

    it('WAL-4 (partial) a donation to a wallet in debt is spendable at once: debt nets the allocation, never the donation', async () => {
      const w = world as World;
      await db.update(wallets).set({ spentCents: PRODUCT_ALLOCATION, debtCents: 300, status: 'over' }).where(eq(wallets.id, w.productWalletId));
      expect(await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: 100 }))
        .toMatchObject({ allowed: false, refusal: { reason: 'source_empty' } });
      await donateToDrive(credentialActor(w.chrisId, null), w.productId, { amountCents: 200, idempotencyKey: createId() }, 'session');
      expect((await listSpendChoices(w.marcusId, w.productId)).find((o) => o.source === 'drive_wallet')?.remainingCents).toBe(200);
      const gate = await canConsumeAI(w.marcusId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: 100 });
      expect(gate).toMatchObject({ allowed: true, walletId: w.productWalletId });
      const [log] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: 0.5 }).returning({ id: aiUsageLogs.id });
      expect(await consumeCredits({ aiUsageLogId: log.id, userId: w.marcusId, costDollars: 0.5, holdId: gate.allowed ? gate.holdId : undefined, walletId: gate.allowed ? gate.walletId : undefined })).toBe('settled');
      expect(await walletRow(w.productWalletId)).toMatchObject({ topupRemainingCents: 125, debtCents: 300 });
    });
  });

  describe('SPEND-6 (partial) D-OW-4: a guest spends a drive wallet only where the drive allows it, always capped; a reached cap or a guest skip tells the lead why', () => {
    const leadSkips = async (w: World) => (await notificationsOf(w.lenaId, 'AUTOMATION_SKIPPED')).map((n) => (n.metadata as { reason: string }).reason);

    it('SPEND-6 (partial) a guest\'s @mention and their chat are refused while the switch is off, charging nothing; the lead hears of the skipped mention', async () => {
      const w = world as World;
      expect(await canConsumeAI(w.chrisId, 'free', { spend: personTriggeredSpend(w.productId), estCostCents: 5 }))
        .toMatchObject({ allowed: false, refusal: { reason: 'guest_drive_wallet_off' } });
      expect(await canConsumeAI(w.chrisId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: 5 }))
        .toMatchObject({ allowed: false, refusal: { source: 'drive_wallet', reason: 'guest_drive_wallet_off' } });
      expect(await liveHolds(w.chrisId)).toHaveLength(0);
      expect(await leadSkips(w)).toEqual(['guest_drive_wallet_off']);
    });

    it('SPEND-6 (partial) with the switch on a guest\'s mention spends the drive wallet, bounded by the default caps (5 credits a day) though no cap row exists', async () => {
      const w = world as World;
      await updateDriveWallet(credentialActor(w.anaId, null), w.productId, { guestSpendEnabled: true }, 'session');
      expect(await canConsumeAI(w.chrisId, 'free', { spend: personTriggeredSpend(w.productId), estCostCents: 5 }))
        .toMatchObject({ allowed: true, walletId: w.productWalletId });
      expect(await canConsumeAI(w.chrisId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: credits(5) }))
        .toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });
      expect(await db.select().from(walletConsumerCaps).where(eq(walletConsumerCaps.walletId, w.productWalletId))).toHaveLength(0);
    });

    it('SPEND-6 (partial) the switch turned off between resolution and the hold still refuses the guest, decided under the wallet lock', async () => {
      const w = world as World;
      await updateDriveWallet(credentialActor(w.anaId, null), w.productId, { guestSpendEnabled: true }, 'session');
      afterResolution.run = async () => {
        await db.update(wallets).set({ guestSpendEnabled: false }).where(eq(wallets.id, w.productWalletId));
      };
      expect(await canConsumeAI(w.chrisId, 'free', { spend: driveSpend(w.productId, 'drive_wallet'), estCostCents: 5 }))
        .toMatchObject({ allowed: false, refusal: { reason: 'guest_drive_wallet_off' } });
      expect(await liveHolds(w.chrisId)).toHaveLength(0);
    });

    it('SPEND-6 (partial) a member whose cap is spent: their mention skips by name and the lead is told it was the cap, not an empty wallet', async () => {
      const w = world as World;
      await setDriveWalletCap(credentialActor(w.anaId, null), w.productId, w.marcusId, { dailyCents: 0, monthlyCents: null }, 'session');
      expect(await canConsumeAI(w.marcusId, 'free', { spend: personTriggeredSpend(w.productId), estCostCents: 5 }))
        .toMatchObject({ allowed: false, refusal: { reason: 'source_cap_reached' } });
      expect(await leadSkips(w)).toEqual(['source_cap_reached']);
      const [notice] = await notificationsOf(w.lenaId, 'AUTOMATION_SKIPPED');
      expect(notice.message).toMatch(/reached their spending cap/);
    });

    it('SPEND-6 (partial) a page-share collaborator who is not a drive member cannot spend the drive wallet by mention', async () => {
      const w = world as World;
      expect(await canConsumeAI(w.danaId, 'free', { spend: personTriggeredSpend(w.productId), estCostCents: 5 }))
        .toMatchObject({ allowed: false });
      expect(await liveHolds(w.danaId)).toHaveLength(0);
    });
  });
});
