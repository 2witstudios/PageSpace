/**
 * Pool refill, allocation reset, funding legs and donations against a real Postgres
 * (Spec MON-3, WAL-3, WAL-4; D-OW-12, D-OW-13). No mocks: the real shell, the real
 * permissions check, migration 0318's wallet_funding_legs.
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
import { organizations, orgSubscriptions, orgSubscriptionFunding } from '@pagespace/db/schema/organizations';
import { creditLedger, creditHolds } from '@pagespace/db/schema/credits';
import { wallets, walletFundingLegs, personalRootWalletOf } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import {
  applyOrgPoolRefill,
  resetDueAllocations,
  donateToDriveWallet,
  refundFundingLeg,
} from '../wallet-funding-shell';
import { isOrgActive } from '../../organizations/status';
import { drawWalletFundingLegs } from '../wallet-legs';
import { canConsumeAI } from '../credit-gate';
import { consumeCredits } from '../credit-consume';
import { providerDollarsCoveredByCents } from '../money-model';

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
    if (created.orgs.length) await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, created.orgs));
    if (created.orgs.length) await db.delete(organizations).where(inArray(organizations.id, created.orgs));
    if (created.users.length) await db.delete(users).where(inArray(users.id, created.users));
  });

  const PERIOD_START_S = Date.UTC(2026, 8, 17) / 1000;
  const PERIOD_END_S = Date.UTC(2026, 9, 17) / 1000;
  // MON-3: the refill recognizes only the Business base and extra-seat lines, by the
  // configured price ids the webhook hands the shell (here: the test's own).
  const PRICES = { basePriceId: 'price_test_org_base', seatPriceId: 'price_test_org_seat' };
  const priced = (priceId: string, line: { amount: number; period: { start: number; end: number } }) => ({
    ...line,
    parent: { subscription_item_details: { subscription_item: 'si_org' } },
    pricing: { price_details: { price: priceId } },
  });

  it.each([0, 1, 5000])('SEAT-8 (partial) first payment %s establishes proof independently of credit rounding and balance', async (paid) => {
    if (!dbAvailable) return;
    const owner = await user();
    const [org] = await db.insert(organizations).values({ name: 'Proof', slug: `proof-${createId()}`, ownerId: owner, stripeCustomerId: `cus_${createId()}` }).returning();
    created.orgs.push(org.id);
    const subscriptionId = `sub_${createId()}`;
    await db.insert(orgSubscriptions).values({ orgId: org.id, stripeSubscriptionId: subscriptionId, stripeBasePriceId: PRICES.basePriceId, stripeBaseItemId: 'si_base', stripeSeatPriceId: PRICES.seatPriceId, stripeSeatItemId: 'si_seat', status: 'active' });
    expect(await isOrgActive(org.id)).toBe(false);
    const invoice = { id: `in_${createId()}`, customer: org.stripeCustomerId, amount_paid: paid, subtotal: 5000, billing_reason: 'subscription_create', parent: { subscription_details: { subscription: subscriptionId } }, lines: { has_more: false, data: [priced(PRICES.basePriceId, { amount: 5000, period: { start: PERIOD_START_S, end: PERIOD_END_S } })] } };
    await applyOrgPoolRefill(invoice, PRICES);
    expect(await isOrgActive(org.id)).toBe(paid > 0);
    const receipts = await db.select().from(orgSubscriptionFunding).where(eq(orgSubscriptionFunding.orgId, org.id));
    expect(receipts).toHaveLength(paid > 0 ? 1 : 0);
    if (paid > 0) expect(receipts[0]).toMatchObject({ stripeSubscriptionId: subscriptionId, stripeInvoiceId: invoice.id, basis: 'paid', paidCents: paid });
    await db.update(wallets).set({ monthlyRemainingCents: 0, topupRemainingCents: 0 }).where(eq(wallets.orgId, org.id));
    expect(await isOrgActive(org.id)).toBe(paid > 0);
    await applyOrgPoolRefill(invoice, PRICES);
    expect(await db.select().from(orgSubscriptionFunding).where(eq(orgSubscriptionFunding.orgId, org.id))).toHaveLength(paid > 0 ? 1 : 0);
    if (paid === 5000) {
      // An existing historical grant can recover missing proof without refilling its spent balance.
      await db.delete(orgSubscriptionFunding).where(eq(orgSubscriptionFunding.orgId, org.id));
      const beforeReplay = await db.select().from(wallets).where(eq(wallets.orgId, org.id));
      expect((await applyOrgPoolRefill(invoice, PRICES)).kind).toBe('duplicate');
      expect(await isOrgActive(org.id)).toBe(true);
      expect(await db.select().from(wallets).where(eq(wallets.orgId, org.id))).toEqual(beforeReplay);
    }
    await db.update(orgSubscriptions).set({ stripeSubscriptionId: `sub_replacement_${createId()}` }).where(eq(orgSubscriptions.orgId, org.id));
    expect(await isOrgActive(org.id)).toBe(false);
  });

  it('MON-3 an org invoice paid for base + 3 extra seats refills the org pool with paid × ratio, once, and stamps the refill date', async () => {
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
        has_more: false,
        data: [
          priced(PRICES.basePriceId, { amount: 5000, period: { start: PERIOD_START_S, end: PERIOD_END_S } }),
          priced(PRICES.seatPriceId, { amount: 3000, period: { start: PERIOD_START_S, end: PERIOD_END_S } }),
        ],
      },
    };

    const first = await applyOrgPoolRefill(invoice, PRICES);
    expect(first).toMatchObject({ kind: 'granted', orgId: org.id, allowanceCents: 8000 });
    const replay = await applyOrgPoolRefill(invoice, PRICES);
    expect(replay).toEqual({ kind: 'duplicate', orgId: org.id });

    const pools = await db.select().from(wallets).where(eq(wallets.orgId, org.id));
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({
      ownerType: 'org',
      subjectType: null,
      parentWalletId: null,
      monthlyRemainingCents: 8000,
      monthlyAllowanceCents: 8000,
    });
    expect(pools[0].monthlyPeriodStart?.getTime()).toBe(PERIOD_START_S * 1000);
    const grants = await db.select().from(creditLedger).where(eq(creditLedger.stripeRef, invoice.id));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ walletId: pools[0].id, entryType: 'monthly_grant', amountCents: 8000, paidCents: 8000 });

    // An OLDER invoice paid late (dunning) is a new stripeRef: it refills once, but it
    // never moves the pool's period — the org's reset date — backwards.
    const lateOld = {
      ...invoice,
      id: `in_${createId()}`,
      lines: { has_more: false, data: invoice.lines.data.map((l) => ({ ...l, period: { start: PERIOD_START_S - 30 * 86_400, end: PERIOD_START_S } })) },
    };
    expect(await applyOrgPoolRefill(lateOld, PRICES)).toMatchObject({ kind: 'granted', allowanceCents: 8000 });
    const [afterLate] = await db.select().from(wallets).where(eq(wallets.id, pools[0].id));
    expect(afterLate.monthlyRemainingCents).toBe(16000);
    expect(afterLate.monthlyPeriodStart?.getTime()).toBe(PERIOD_START_S * 1000);
    expect(afterLate.monthlyPeriodEnd?.getTime()).toBe(PERIOD_END_S * 1000);

    // A customer that is no org's is left to the personal path.
    expect(await applyOrgPoolRefill({ ...invoice, customer: `cus_${createId()}` })).toEqual({ kind: 'not_org' });
  });

  it.each([
    { label: 'more lines on a later page', lines: { has_more: true } },
    { label: 'no pagination flag', lines: {} },
    { label: 'no line collection', lines: null },
  ])('MON-3 (partial) a truncated invoice ($label) throws for redelivery and writes no refill or funding proof', async ({ lines }) => {
    if (!dbAvailable) return;
    const owner = await user();
    const [org] = await db
      .insert(organizations)
      .values({ name: 'Paged Ltd', slug: `paged-${createId()}`, ownerId: owner, stripeCustomerId: `cus_${createId()}` })
      .returning();
    created.orgs.push(org.id);
    const subscriptionId = `sub_${createId()}`;
    const invoice = {
      id: `in_${createId()}`,
      customer: org.stripeCustomerId,
      billing_reason: 'subscription_create',
      amount_paid: 5000,
      subtotal: 5000,
      parent: { subscription_details: { subscription: subscriptionId } },
      lines: lines === null ? null : {
        ...lines,
        data: [priced(PRICES.basePriceId, { amount: 5000, period: { start: PERIOD_START_S, end: PERIOD_END_S } })],
      },
    };

    await expect(applyOrgPoolRefill(invoice, PRICES)).rejects.toThrow(/every line of invoice/);
    expect(await db.select().from(wallets).where(eq(wallets.orgId, org.id))).toEqual([]);
    expect(await db.select().from(creditLedger).where(eq(creditLedger.stripeRef, invoice.id))).toEqual([]);
    expect(await db.select().from(orgSubscriptionFunding).where(eq(orgSubscriptionFunding.orgId, org.id))).toEqual([]);
  });

  it('MON-3 an ad-hoc invoice line does not refill the pool: the grant sizes only the recognized base + seat lines, whatever collected', async () => {
    if (!dbAvailable) return;
    const owner = await user();
    const [org] = await db
      .insert(organizations)
      .values({ name: 'Adhoc Corp', slug: `adhoc-${createId()}`, ownerId: owner, stripeCustomerId: `cus_${createId()}` })
      .returning();
    created.orgs.push(org.id);
    // Base + 3 seats (8000) plus a manually added invoice item of 2500 that is no plan line.
    // Pre-fix behavior summed every line: 10500 paid would mint 10500 — the review's bug.
    const invoice = {
      id: `in_${createId()}`,
      customer: org.stripeCustomerId,
      billing_reason: 'subscription_cycle',
      amount_paid: 10500,
      subtotal: 10500,
      parent: { subscription_details: { subscription: `sub_${createId()}` } },
      lines: {
        has_more: false,
        data: [
          priced(PRICES.basePriceId, { amount: 5000, period: { start: PERIOD_START_S, end: PERIOD_END_S } }),
          priced(PRICES.seatPriceId, { amount: 3000, period: { start: PERIOD_START_S, end: PERIOD_END_S } }),
          { amount: 2500, period: { start: PERIOD_START_S, end: PERIOD_END_S } },
        ],
      },
    };

    expect(await applyOrgPoolRefill(invoice, PRICES)).toMatchObject({
      kind: 'granted',
      orgId: org.id,
      allowanceCents: 8000,
    });
    const [pool] = await db.select().from(wallets).where(eq(wallets.orgId, org.id));
    expect(pool).toMatchObject({ monthlyRemainingCents: 8000, monthlyAllowanceCents: 8000 });
    const grants = await db.select().from(creditLedger).where(eq(creditLedger.stripeRef, invoice.id));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ amountCents: 8000, paidCents: 8000 });
  });

  it.each([
    { gifted: false, oldCredit: false }, { gifted: true, oldCredit: false }, { gifted: true, oldCredit: true },
  ])('MON-3 (partial) unknown replacement prices on stored org items cannot fund a pool (%j)', async ({ gifted, oldCredit }) => {
    if (!dbAvailable) return;
    const owner = await user();
    const [org] = await db.insert(organizations).values({
      name: 'Identity test', slug: `identity-${createId()}`, ownerId: owner, stripeCustomerId: `cus_${createId()}`,
    }).returning();
    created.orgs.push(org.id);
    const subscriptionId = `sub_${createId()}`;
    const itemId = `si_${createId()}`;
    await db.insert(orgSubscriptions).values({
      orgId: org.id, stripeSubscriptionId: subscriptionId,
      stripeBasePriceId: PRICES.basePriceId, stripeBaseItemId: itemId,
      stripeSeatPriceId: PRICES.seatPriceId, stripeSeatItemId: `si_${createId()}`, status: 'active',
    });
    const [pool] = await db.insert(wallets).values({
      ownerType: 'org', orgId: org.id, monthlyRemainingCents: 1234, topupRemainingCents: 567,
    }).returning();
    const invoice = {
      id: `in_${createId()}`, customer: org.stripeCustomerId,
      billing_reason: 'subscription_cycle', amount_paid: gifted ? 0 : 5000, subtotal: 5000,
      parent: { subscription_details: { subscription: subscriptionId, metadata: gifted ? { type: 'gift_subscription' } : undefined } },
      lines: { has_more: false, data: [...(oldCredit ? [{
        ...priced(PRICES.basePriceId, { amount: -5000, period: { start: PERIOD_START_S, end: PERIOD_END_S } }),
        parent: { subscription_item_details: { subscription_item: itemId } },
      }] : []), {
        ...priced('price_retired', { amount: 5000, period: { start: PERIOD_START_S, end: PERIOD_END_S } }),
        parent: { subscription_item_details: { subscription_item: itemId } },
      }] },
    };
    expect(await applyOrgPoolRefill(invoice, PRICES)).toMatchObject({ kind: 'nothing' });
    expect(await walletRow(pool.id)).toEqual(pool);
    expect(await db.select().from(creditLedger).where(eq(creditLedger.stripeRef, invoice.id))).toEqual([]);
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

  it('an old Home wallet is not refilled: its allocation ends at the reset, so it only runs down', async () => {
    if (!dbAvailable) return;
    const person = await user();
    const home = await factories.createDrive(person, { kind: 'HOME' });
    created.drives.push(home.id);
    const personalStart = new Date(Date.UTC(2026, 8, 3));
    const root = await personalRoot(person, 0, { start: personalStart, end: new Date(Date.UTC(2026, 9, 3)) });
    const homeWallet = await childWallet({
      userId: person, subjectType: 'drive', subjectId: home.id, parentWalletId: root,
      monthlyAllowanceCents: 1000, spentCents: 900, debtCents: 0,
      monthlyPeriodStart: new Date(Date.UTC(2026, 7, 3)),
    });

    expect((await resetDueAllocations({ now: new Date(Date.UTC(2026, 8, 20, 12)) })).failed).toBe(0);
    const after = await walletRow(homeWallet);
    expect(after).toMatchObject({ monthlyAllowanceCents: 0, spentCents: 0, debtCents: 0 });
    expect(after.monthlyPeriodStart?.getTime()).toBe(personalStart.getTime());
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
  it.each(['named funder', 'wallet owner', 'org owner'] as const)('records a refundable owner leg under its %s and removes only the refunded cents', async (payer) => {
    if (!dbAvailable) return;
    const owner = await user();
    const funder = await user();
    let parentId: string;
    let orgId: string | undefined;
    if (payer === 'org owner') {
      const [org] = await db.insert(organizations).values({ name: 'Refund org', slug: `refund-${createId()}`, ownerId: owner }).returning();
      created.orgs.push(org.id);
      orgId = org.id;
      const [pool] = await db.insert(wallets).values({ ownerType: 'org', orgId }).returning();
      created.rootWallets.push(pool.id);
      parentId = pool.id;
    } else {
      parentId = await personalRoot(owner, 0);
    }
    const drive = await factories.createDrive(owner, { orgId });
    created.drives.push(drive.id);
    const target = await childWallet({
      ownerType: orgId ? 'org' : 'user', orgId, userId: orgId ? null : owner,
      subjectType: 'drive', subjectId: drive.id, parentWalletId: parentId,
    });
    const leg = await db.transaction(async tx => {
      const [row] = await tx.insert(walletFundingLegs).values({
        walletId: target, funderKind: 'owner', funderUserId: payer === 'named funder' ? funder : null,
        funderOrgId: orgId, originalCents: 500, remainingCents: 500, nonRefundable: false,
      }).returning();
      await tx.update(wallets).set({ topupRemainingCents: 500 }).where(eq(wallets.id, target));
      return row;
    });
    expect(await refundFundingLeg(leg.id, 200)).toEqual({ kind: 'refund', legId: leg.id, cents: 200, remainingCents: 300 });
    expect((await walletRow(target)).topupRemainingCents).toBe(300);
    expect((await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.id, leg.id)))[0].remainingCents).toBe(300);
    const recordedUnder = payer === 'named funder' ? funder : owner;
    expect(await db.select().from(creditLedger).where(eq(creditLedger.walletId, target))).toEqual([
      expect.objectContaining({ userId: recordedUnder, entryType: 'leg_refund', amountCents: -200, appliedCents: -200 }),
    ]);
    expect(await refundFundingLeg(leg.id, 300)).toEqual({ kind: 'refund', legId: leg.id, cents: 300, remainingCents: 0 });
    expect((await walletRow(target)).topupRemainingCents).toBe(0);
    expect((await walletRow(parentId)).topupRemainingCents).toBe(0);
    expect(await refundFundingLeg(leg.id, 1)).toEqual({ kind: 'refuse', legId: leg.id, reason: 'exceeds_remaining' });
    expect(await db.select().from(creditLedger).where(eq(creditLedger.walletId, target))).toHaveLength(2);
  });

  it('refuses missing, malformed and non-refundable owner-leg refunds without changing money', async () => {
    if (!dbAvailable) return;
    const owner = await user();
    const root = await personalRoot(owner, 0);
    const target = await childWallet({ userId: owner, subjectType: 'drive', subjectId: `drv_${createId()}`, parentWalletId: root });
    const leg = await db.transaction(async tx => {
      const [row] = await tx.insert(walletFundingLegs).values({ walletId: target, funderKind: 'owner', funderUserId: owner, originalCents: 500, remainingCents: 500, nonRefundable: false }).returning();
      await tx.update(wallets).set({ topupRemainingCents: 500 }).where(eq(wallets.id, target));
      return row;
    });
    for (const amount of [-1, 0, 0.5]) {
      expect(await refundFundingLeg(leg.id, amount)).toEqual({ kind: 'refuse', legId: leg.id, reason: 'invalid_amount' });
    }
    const missing = createId();
    expect(await refundFundingLeg(missing, 100)).toEqual({ kind: 'refuse', legId: missing, reason: 'invalid_amount' });
    await db.update(walletFundingLegs).set({ nonRefundable: true }).where(eq(walletFundingLegs.id, leg.id));
    expect(await refundFundingLeg(leg.id, 100)).toEqual({ kind: 'refuse', legId: leg.id, reason: 'non_refundable' });
    expect((await walletRow(target)).topupRemainingCents).toBe(500);
    expect((await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.id, leg.id)))[0].remainingCents).toBe(500);
    expect(await db.select().from(creditLedger).where(eq(creditLedger.walletId, target))).toEqual([]);
  });

  it('does not create a pool or funding proof for missing invoice identity or disabled billing', async () => {
    if (!dbAvailable) return;
    const owner = await user();
    const [org] = await db.insert(organizations).values({ name: 'Unfunded org', slug: `unfunded-${createId()}`, ownerId: owner, stripeCustomerId: `cus_${createId()}` }).returning();
    created.orgs.push(org.id);
    expect(await applyOrgPoolRefill({ customer: { id: org.stripeCustomerId ?? '' } })).toEqual({ kind: 'nothing', orgId: org.id, reason: 'no_invoice_id' });
    expect(await applyOrgPoolRefill({ id: createId(), customer: null })).toEqual({ kind: 'not_org' });
    process.env.DEPLOYMENT_MODE = 'onprem';
    try {
      expect(await applyOrgPoolRefill({ id: createId(), customer: org.stripeCustomerId })).toEqual({ kind: 'billing_disabled' });
    } finally {
      process.env.DEPLOYMENT_MODE = 'cloud';
    }
    expect(await db.select().from(wallets).where(eq(wallets.orgId, org.id))).toEqual([]);
    expect(await db.select().from(orgSubscriptionFunding).where(eq(orgSubscriptionFunding.orgId, org.id))).toEqual([]);
  });
  it.each(['root', 'child'] as const)('keeps an admitted %s call backed when its owner tries to donate the reserved money', async (heldOn) => {
    if (!dbAvailable) return;
    const owner = await user();
    await db.update(users).set({ subscriptionTier: 'pro' }).where(eq(users.id, owner));
    const source = await factories.createDrive(owner);
    const target = await factories.createDrive(owner);
    created.drives.push(source.id, target.id);
    const root = await personalRoot(owner, 0);
    await db.update(wallets).set({ monthlyRemainingCents: 150, monthlyAllowanceCents: 150 }).where(eq(wallets.id, root));
    const child = await childWallet({ userId: owner, subjectType: 'drive', subjectId: source.id, parentWalletId: root, monthlyAllowanceCents: 150 });
    const targetWallet = await childWallet({ userId: owner, subjectType: 'drive', subjectId: target.id, parentWalletId: root, donationsEnabled: true });
    const chargedWallet = heldOn === 'root' ? root : child;
    const gate = await canConsumeAI(owner, 'pro', {
      estCostCents: 80,
      spend: heldOn === 'child' ? { kind: 'drive', driveId: source.id, chosen: 'drive_wallet' } : { kind: 'personal' },
    });
    expect(gate).toMatchObject({ allowed: true, walletId: chargedWallet });
    expect(gate.holdId).toEqual(expect.any(String));
    const [hold] = await db.select().from(creditHolds).where(eq(creditHolds.id, gate.holdId ?? ''));
    expect(hold).toMatchObject({ walletId: chargedWallet, estCents: 80 });
    expect(hold.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect((await walletRow(root)).monthlyRemainingCents).toBe(150);
    expect(await donateToDriveWallet({ donorUserId: owner, targetWalletId: targetWallet, donationId: createId(), amountCents: 150 })).toEqual({ kind: 'refused', reason: 'insufficient_funds' });
    expect((await walletRow(root)).monthlyRemainingCents).toBe(150);
    expect((await walletRow(targetWallet)).topupRemainingCents).toBe(0);
    expect(await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, targetWallet))).toEqual([]);
    expect(await consumeCredits({ userId: owner, walletId: chargedWallet, holdId: gate.holdId, aiUsageLogId: createId(), costDollars: providerDollarsCoveredByCents(80) })).toBe('settled');
    expect(await walletRow(root)).toMatchObject({ monthlyRemainingCents: 70, debtCents: 0 });
    expect((await walletRow(child)).spentCents).toBe(heldOn === 'child' ? 80 : 0);
    expect(await db.select().from(creditHolds).where(eq(creditHolds.userId, owner))).toEqual([]);
    const ledger = await db.select().from(creditLedger).where(eq(creditLedger.userId, owner));
    expect(ledger.filter(row => row.entryType === 'usage')).toEqual([expect.objectContaining({ walletId: chargedWallet, amountCents: -80 })]);
    expect(ledger.filter(row => row.entryType === 'debt')).toEqual([]);
  });
});
