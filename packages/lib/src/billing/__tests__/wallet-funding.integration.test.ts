/**
 * Pool refill, allocation reset, funding legs and donations against a real Postgres
 * (Spec MON-3, WAL-3, WAL-4; D-OW-12, D-OW-13). No mocks: the real shell, the real
 * permissions check, migration 0307's wallet_funding_legs.
 *
 * Requires DATABASE_URL → a migrated Postgres; fails loudly without one (requireDb).
 * Deletes every row it creates in dependency order — ledger, child wallets, root
 * wallets, members, drives, orgs, users last — and the integration teardown ends the pool.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray, and } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { organizations } from '@pagespace/db/schema/organizations';
import { creditLedger } from '@pagespace/db/schema/credits';
import { wallets, walletFundingLegs, personalRootWalletOf } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import {
  applyOrgPoolRefill,
  resetDueAllocations,
  donateToDriveWallet,
  refundFundingLeg,
} from '../wallet-funding-shell';
import { drawWalletFundingLegs } from '../wallet-legs';

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;

const created = { users: [] as string[], drives: [] as string[], orgs: [] as string[], childWallets: [] as string[], rootWallets: [] as string[] };

async function user(): Promise<string> {
  const u = await factories.createUser({ subscriptionTier: 'free' });
  created.users.push(u.id);
  return u.id;
}

async function personalRoot(userId: string, topupCents: number, period?: { start: Date; end: Date }): Promise<string> {
  const [w] = await db
    .insert(wallets)
    .values({ ownerType: 'user', userId, topupRemainingCents: topupCents, monthlyPeriodStart: period?.start, monthlyPeriodEnd: period?.end })
    .returning({ id: wallets.id });
  created.rootWallets.push(w.id);
  return w.id;
}

async function childWallet(values: Partial<typeof wallets.$inferInsert> & { parentWalletId: string }): Promise<string> {
  const [w] = await db.insert(wallets).values({ ownerType: 'user', ...values }).returning({ id: wallets.id });
  created.childWallets.push(w.id);
  return w.id;
}

async function walletRow(id: string) {
  const [w] = await db.select().from(wallets).where(eq(wallets.id, id));
  return w;
}

describe('wallet funding against Postgres', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: walletFundingLegs.id }).from(walletFundingLegs).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('wallet-funding.integration.test.ts', error);
      dbAvailable = false;
    }
    process.env.DEPLOYMENT_MODE = 'cloud';
  });

  afterAll(async () => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    if (!dbAvailable) return;
    const allWallets = [...created.childWallets, ...created.rootWallets];
    const pools = created.orgs.length
      ? (await db.select({ id: wallets.id }).from(wallets).where(inArray(wallets.orgId, created.orgs))).map((w) => w.id)
      : [];
    if (created.users.length) await db.delete(creditLedger).where(inArray(creditLedger.userId, created.users));
    if (created.childWallets.length) await db.delete(wallets).where(inArray(wallets.id, created.childWallets));
    if (allWallets.length || pools.length) await db.delete(wallets).where(inArray(wallets.id, [...allWallets, ...pools]));
    if (created.users.length) await db.delete(wallets).where(inArray(wallets.userId, created.users));
    if (created.drives.length) {
      await db.delete(driveMembers).where(inArray(driveMembers.driveId, created.drives));
      await db.delete(drives).where(inArray(drives.id, created.drives));
    }
    if (created.orgs.length) await db.delete(organizations).where(inArray(organizations.id, created.orgs));
    if (created.users.length) await db.delete(users).where(inArray(users.id, created.users));
  });

  const PERIOD_START_S = Date.UTC(2026, 8, 17) / 1000;
  const PERIOD_END_S = Date.UTC(2026, 9, 17) / 1000;

  it('MON-3 (partial) an org invoice paid for base + 3 extra seats refills the org pool with paid × ratio, once, and stamps the refill date', async () => {
    if (!dbAvailable) return;
    const owner = await user();
    const [org] = await db
      .insert(organizations)
      .values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: owner, stripeCustomerId: `cus_${createId()}` })
      .returning();
    created.orgs.push(org.id);
    const invoice = {
      id: `in_${createId()}`,
      customer: org.stripeCustomerId,
      billing_reason: 'subscription_cycle',
      amount_paid: 8000,
      subtotal: 8000,
      parent: { subscription_details: { subscription: `sub_${createId()}` } },
      lines: {
        data: [
          { amount: 5000, period: { start: PERIOD_START_S, end: PERIOD_END_S } },
          { amount: 3000, period: { start: PERIOD_START_S, end: PERIOD_END_S } },
        ],
      },
    };

    const first = await applyOrgPoolRefill(invoice, { active: true });
    expect(first).toMatchObject({ kind: 'granted', orgId: org.id, allowanceCents: 4800 });
    const replay = await applyOrgPoolRefill(invoice, { active: true });
    expect(replay).toEqual({ kind: 'duplicate', orgId: org.id });

    const pools = await db.select().from(wallets).where(eq(wallets.orgId, org.id));
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({
      ownerType: 'org',
      subjectType: null,
      parentWalletId: null,
      monthlyRemainingCents: 4800,
      monthlyAllowanceCents: 4800,
    });
    expect(pools[0].monthlyPeriodStart?.getTime()).toBe(PERIOD_START_S * 1000);
    const grants = await db.select().from(creditLedger).where(eq(creditLedger.stripeRef, invoice.id));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ walletId: pools[0].id, entryType: 'monthly_grant', amountCents: 4800, paidCents: 8000 });

    // An OLDER invoice paid late (dunning) is a new stripeRef: it refills once, but it
    // never moves the pool's period — the org's reset date — backwards.
    const lateOld = {
      ...invoice,
      id: `in_${createId()}`,
      lines: { data: invoice.lines.data.map((l) => ({ ...l, period: { start: PERIOD_START_S - 30 * 86_400, end: PERIOD_START_S } })) },
    };
    expect(await applyOrgPoolRefill(lateOld, { active: true })).toMatchObject({ kind: 'granted', allowanceCents: 4800 });
    const [afterLate] = await db.select().from(wallets).where(eq(wallets.id, pools[0].id));
    expect(afterLate.monthlyRemainingCents).toBe(9600);
    expect(afterLate.monthlyPeriodStart?.getTime()).toBe(PERIOD_START_S * 1000);
    expect(afterLate.monthlyPeriodEnd?.getTime()).toBe(PERIOD_END_S * 1000);

    // A customer that is no org's is left to the personal path.
    expect(await applyOrgPoolRefill({ ...invoice, customer: `cus_${createId()}` })).toEqual({ kind: 'not_org' });
  });

  it('WAL-3 (partial) D-OW-12 org allocations reset on the pool refill date, personal ones on the personal renewal; running it twice resets once', async () => {
    if (!dbAvailable) return;
    const owner = await user();
    const [org] = await db
      .insert(organizations)
      .values({ name: 'Reset Org', slug: `reset-${createId()}`, ownerId: owner })
      .returning();
    created.orgs.push(org.id);
    const poolStart = new Date(Date.UTC(2026, 8, 17));
    const poolEnd = new Date(Date.UTC(2026, 9, 17));
    const [pool] = await db
      .insert(wallets)
      .values({ ownerType: 'org', orgId: org.id, monthlyPeriodStart: poolStart, monthlyPeriodEnd: poolEnd })
      .returning({ id: wallets.id });
    created.rootWallets.push(pool.id);
    const person = await user();
    const personalStart = new Date(Date.UTC(2026, 8, 3));
    const personalEnd = new Date(Date.UTC(2026, 9, 3));
    const root = await personalRoot(person, 0, { start: personalStart, end: personalEnd });

    const orgChild = await childWallet({
      ownerType: 'org', orgId: org.id, subjectType: 'drive', subjectId: `drv_${createId()}`, parentWalletId: pool.id,
      monthlyAllowanceCents: 1000, spentCents: 700, debtCents: 0,
      monthlyPeriodStart: new Date(Date.UTC(2026, 7, 17)),
    });
    const personalChild = await childWallet({
      userId: person, subjectType: 'drive', subjectId: `drv_${createId()}`, parentWalletId: root,
      monthlyAllowanceCents: 1000, spentCents: 900, debtCents: 150, status: 'over',
      monthlyPeriodStart: new Date(Date.UTC(2026, 7, 3)),
    });
    const now = new Date(Date.UTC(2026, 8, 20, 12));

    const firstRun = await resetDueAllocations({ now });
    expect(firstRun.failed).toBe(0);
    const orgAfter = await walletRow(orgChild);
    expect(orgAfter).toMatchObject({ spentCents: 0, debtCents: 0, status: 'active' });
    expect(orgAfter.monthlyPeriodStart?.getTime()).toBe(poolStart.getTime());
    expect(orgAfter.monthlyPeriodEnd?.getTime()).toBe(poolEnd.getTime());
    const personalAfter = await walletRow(personalChild);
    expect(personalAfter).toMatchObject({ spentCents: 150, debtCents: 0, status: 'active' });
    expect(personalAfter.monthlyPeriodStart?.getTime()).toBe(personalStart.getTime());

    // Spend lands between runs; a second run in the same period must not wipe it.
    await db.update(wallets).set({ spentCents: 400 }).where(eq(wallets.id, orgChild));
    await resetDueAllocations({ now: new Date(now.getTime() + 3_600_000) });
    expect((await walletRow(orgChild)).spentCents).toBe(400);
    expect((await walletRow(personalChild)).spentCents).toBe(150);
  });

  it('WAL-4 (partial) D-OW-13 two donors fund one drive wallet: legs FIFO, exact to the cent, a ledger pair each, no refund from a donation leg', async () => {
    if (!dbAvailable) return;
    const lead = await user();
    const ana = await user();
    const marcus = await user();
    const outsider = await user();
    const drive = await factories.createDrive(lead);
    created.drives.push(drive.id);
    await factories.createDriveMembers(drive.id, [ana, marcus], { acceptedAt: new Date() });

    const leadRoot = await personalRoot(lead, 0);
    const anaRoot = await personalRoot(ana, 1000);
    const marcusRoot = await personalRoot(marcus, 1000);
    await personalRoot(outsider, 1000);
    const productWallet = await childWallet({ userId: lead, subjectType: 'drive', subjectId: drive.id, parentWalletId: leadRoot });

    const anaGift = createId();
    expect(await donateToDriveWallet({ donorUserId: ana, targetWalletId: productWallet, amountCents: 500, donationId: anaGift })).toMatchObject({ kind: 'donated', amountCents: 500 });
    expect(await donateToDriveWallet({ donorUserId: marcus, targetWalletId: productWallet, amountCents: 300, donationId: createId() })).toMatchObject({ kind: 'donated', amountCents: 300 });

    // A replayed donation moves nothing.
    expect(await donateToDriveWallet({ donorUserId: ana, targetWalletId: productWallet, amountCents: 500, donationId: anaGift })).toMatchObject({ kind: 'duplicate' });
    // Someone who cannot see the drive cannot donate to it.
    expect(await donateToDriveWallet({ donorUserId: outsider, targetWalletId: productWallet, amountCents: 100, donationId: createId() })).toEqual({ kind: 'refused', reason: 'cannot_see_drive' });

    expect((await db.select().from(wallets).where(personalRootWalletOf(ana)))[0].topupRemainingCents).toBe(500);
    expect((await walletRow(marcusRoot)).topupRemainingCents).toBe(700);
    expect((await walletRow(anaRoot)).topupRemainingCents).toBe(500);
    expect((await walletRow(productWallet)).topupRemainingCents).toBe(800);

    const legs = await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, productWallet));
    expect(legs.map((l) => [l.funderUserId, l.funderKind, l.originalCents, l.remainingCents, l.nonRefundable]).sort()).toEqual(
      [[ana, 'donation', 500, 500, true], [marcus, 'donation', 300, 300, true]].sort(),
    );
    const ledger = await db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.entryType, 'donation'), inArray(creditLedger.userId, [ana, marcus])));
    expect(ledger.map((r) => [r.userId, r.walletId, r.amountCents]).sort()).toEqual(
      [[ana, anaRoot, -500], [ana, productWallet, 500], [marcus, marcusRoot, -300], [marcus, productWallet, 300]].sort(),
    );

    // Spend draws Ana's older leg first, then Marcus's.
    const drawn = await db.transaction((tx) => drawWalletFundingLegs(tx, productWallet, 537));
    const anaLeg = legs.find((l) => l.funderUserId === ana)!;
    const marcusLeg = legs.find((l) => l.funderUserId === marcus)!;
    expect(drawn).toEqual({ draws: [{ legId: anaLeg.id, cents: 500 }, { legId: marcusLeg.id, cents: 37 }], appliedCents: 537, shortfallCents: 0 });
    const after = await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, productWallet));
    expect(Object.fromEntries(after.map((l) => [l.id, l.remainingCents]))).toEqual({ [anaLeg.id]: 0, [marcusLeg.id]: 263 });
    expect((await walletRow(productWallet)).topupRemainingCents).toBe(263);

    // A refund attempt against a donation leg refuses and changes nothing.
    expect(await refundFundingLeg(marcusLeg.id, 100)).toEqual({ kind: 'refuse', legId: marcusLeg.id, reason: 'donation_non_refundable' });
    expect((await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.id, marcusLeg.id)))[0].remainingCents).toBe(263);
    expect((await walletRow(productWallet)).topupRemainingCents).toBe(263);

    // The lead turns donations off: the next donation refuses.
    await db.update(wallets).set({ donationsEnabled: false }).where(eq(wallets.id, productWallet));
    expect(await donateToDriveWallet({ donorUserId: ana, targetWalletId: productWallet, amountCents: 100, donationId: createId() })).toEqual({ kind: 'refused', reason: 'donations_disabled' });

    // A replay of Ana's completed gift, after she spent below its amount and with
    // donations now off, still reports the gift it already made — not a refusal.
    await db.update(wallets).set({ topupRemainingCents: 100 }).where(eq(wallets.id, anaRoot));
    expect(await donateToDriveWallet({ donorUserId: ana, targetWalletId: productWallet, amountCents: 500, donationId: anaGift })).toEqual({ kind: 'duplicate', legId: anaLeg.id });
  });

  it('D-OW-13 the database itself refuses a refundable donation leg', async () => {
    if (!dbAvailable) return;
    const owner = await user();
    const root = await personalRoot(owner, 0);
    const w = await childWallet({ userId: owner, subjectType: 'drive', subjectId: `drv_${createId()}`, parentWalletId: root });
    await expect(
      db.insert(walletFundingLegs).values({ walletId: w, funderKind: 'donation', funderUserId: owner, originalCents: 100, remainingCents: 100, nonRefundable: false }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ constraint: 'wallet_funding_legs_donation_non_refundable' }) });
  });
});
