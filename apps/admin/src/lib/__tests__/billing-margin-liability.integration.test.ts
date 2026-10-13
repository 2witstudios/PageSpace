/**
 * MON-7 against a real Postgres: admin billing reports margin as charged value minus provider
 * cost, attributed to the tier that PAYS (org pool and org drive spend is Business whoever spent
 * it), and included credit liability as grants outstanding on personal roots and org pools —
 * separate from top-up cash, never counting a pool's allocation to a drive wallet twice.
 *
 * Margin reads are scoped by a date window no other suite writes in. Liability reads are
 * scoped to THIS suite's wallet ids (`within`): parallel suites share the database and
 * mutate other wallets between two reads, so an unscoped delta can observe their rows.
 * Every row created is deleted.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { organizations } from '@pagespace/db/schema/organizations';
import { creditLedger } from '@pagespace/db/schema/credits';
import { wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { getCreditLiability, getCreditRevenue, getMarginByTier, getUnitEconomicsSummary } from '../monitoring-queries';

const created = { users: [] as string[], orgs: [] as string[], roots: [] as string[], children: [] as string[] };

afterAll(async () => {
  const every = [...created.children, ...created.roots];
  if (every.length) await db.delete(creditLedger).where(inArray(creditLedger.walletId, every));
  if (created.children.length) await db.delete(wallets).where(inArray(wallets.id, created.children));
  if (created.roots.length) await db.delete(wallets).where(inArray(wallets.id, created.roots));
  if (created.orgs.length) await db.delete(organizations).where(inArray(organizations.id, created.orgs));
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users));
  await pool.end();
});

async function user(tier: 'free' | 'pro'): Promise<string> {
  const u = await factories.createUser({ subscriptionTier: tier });
  created.users.push(u.id);
  return u.id;
}

async function wallet(values: typeof wallets.$inferInsert, child = false): Promise<string> {
  const [w] = await db.insert(wallets).values(values).returning({ id: wallets.id });
  (child ? created.children : created.roots).push(w.id);
  return w.id;
}

// A window in the past no other suite writes usage in, so the margin figures are exactly ours.
const windowStart = new Date(Date.UTC(1990 + Math.floor(Math.random() * 20), Math.floor(Math.random() * 12), 1, Math.floor(Math.random() * 24)));
const windowEnd = new Date(windowStart.getTime() + 60 * 60 * 1000);
const inWindow = new Date(windowStart.getTime() + 30 * 60 * 1000);

/** One settled AI call: `realCostCents` of provider cost charged at `chargedCents`. */
async function usage(userId: string, walletId: string, realCostCents: number, chargedCents: number): Promise<void> {
  await db.insert(creditLedger).values({
    userId,
    walletId,
    entryType: 'usage',
    bucket: 'monthly',
    amountCents: -chargedCents,
    appliedCents: -chargedCents,
    chargeMillicents: chargedCents * 1000,
    realCostCents,
    aiUsageLogId: `log_${createId()}`,
    consumeStatus: 'applied',
    createdAt: inWindow,
  });
}

async function funding(userId: string, walletId: string, entryType: 'monthly_grant' | 'topup_purchase', cents: number): Promise<void> {
  await db.insert(creditLedger).values({
    userId,
    walletId,
    entryType,
    bucket: entryType === 'monthly_grant' ? 'monthly' : 'topup',
    amountCents: cents,
    stripeRef: `ref_${createId()}`,
    consumeStatus: 'applied',
    createdAt: inWindow,
  });
}

describe('MON-7 admin billing reports margin as charged value minus provider cost (personal and org-pool usage, attributed to the paying tier) and included credit liability as grants outstanding on personal roots and org pools, separate from top-up cash and never counting an allocation twice', () => {
  it('margin is charged minus cost per paying tier, and the liability counts each grant once and apart from cash', async () => {
    const pro = await user('pro');
    const free = await user('free');
    const proRoot = await wallet({ ownerType: 'user', userId: pro, monthlyRemainingCents: 900, topupRemainingCents: 250 });
    const freeRoot = await wallet({ ownerType: 'user', userId: free, monthlyRemainingCents: 500 });
    const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `mon7-${createId()}`, ownerId: pro }).returning();
    created.orgs.push(org.id);
    const orgPool = await wallet({ ownerType: 'org', orgId: org.id, monthlyRemainingCents: 4800 });
    // The pool allocates 3,000 a month to an org drive's wallet: a budget drawn on the pool, not money.
    const driveWallet = await wallet(
      { ownerType: 'org', orgId: org.id, subjectType: 'drive', subjectId: `drv_${createId()}`, parentWalletId: orgPool, monthlyAllowanceCents: 3000 },
      true,
    );

    // Usage: the Pro member on their own root, then on the org pool and the org drive wallet;
    // the free member on their own root.
    await usage(pro, proRoot, 100, 150);
    await usage(pro, orgPool, 200, 300);
    await usage(free, driveWallet, 40, 60);
    await usage(free, freeRoot, 10, 15);
    // Funding flows in the same window: one grant, one top-up purchase.
    await funding(pro, proRoot, 'monthly_grant', 900);
    await funding(pro, proRoot, 'topup_purchase', 250);

    // Margin: charged value versus provider cost, summed and per paying tier.
    expect(await getUnitEconomicsSummary(windowStart, windowEnd)).toMatchObject({
      realCostCents: 350,
      chargedCents: 525,
      marginCents: 175,
      requestCount: 4,
    });
    const byTier = Object.fromEntries((await getMarginByTier(windowStart, windowEnd)).map((r) => [r.tier, r]));
    // Org-pool and org-drive spend is Business though a Pro and a free member spent it.
    expect(byTier.business).toMatchObject({ realCostCents: 240, chargedCents: 360, marginCents: 120, requestCount: 2 });
    expect(byTier.pro).toMatchObject({ realCostCents: 100, chargedCents: 150, marginCents: 50, requestCount: 1 });
    expect(byTier.free).toMatchObject({ realCostCents: 10, chargedCents: 15, marginCents: 5, requestCount: 1 });
    expect(Object.keys(byTier).sort()).toEqual(['business', 'free', 'pro']);

    // Liability: grants outstanding on personal roots (900 + the 500 starter) and the org pool
    // (4,800); the drive wallet's 3,000 allocation is not counted again; top-up cash is apart.
    // The read is scoped to this suite's wallets, so parallel suites sharing the database
    // cannot move the numbers between seeding and assertion.
    const ours = inArray(wallets.id, [...created.roots, ...created.children]);
    const liability = await getCreditLiability(ours);
    expect(liability.monthlyRemainingCents).toBe(900 + 500 + 4800);
    expect(liability.orgPoolMonthlyRemainingCents).toBe(4800);
    expect(liability.starterGrantRemainingCents).toBe(500);
    expect(liability.topupRemainingCents).toBe(250);
    expect(liability.totalLiabilityCents).toBe(900 + 500 + 4800 + 250);
    expect(liability.orgPoolCount).toBe(1);

    // The revenue split keeps cash (top-ups) and grant flow apart, and carries the same liability.
    const revenue = await getCreditRevenue(windowStart, windowEnd, ours);
    expect(revenue).toMatchObject({ topupCents: 250, topupCount: 1, monthlyGrantCents: 900, monthlyGrantCount: 1 });
    expect(revenue.includedCreditLiabilityCents).toBe(900 + 500 + 4800);
  });
});
