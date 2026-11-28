import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { creditLedger } from '@pagespace/db/schema/credits';
import { wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { reconcileSubscriptionTiers } from '../subscription-tier-reconcile';
import { reconcileMissedGrants } from '../missed-grant-reconcile';
import { applyStripeFunding } from '../credit-funding';

const createdUsers: string[] = [];
const priorMode = process.env.DEPLOYMENT_MODE;
const priceTier = (id: string) => id === 'price_verified_pro' ? 'pro' as const : 'free' as const;

async function subscriber(priceId?: string) {
  const user = await factories.createUser({ subscriptionTier: 'pro', stripeCustomerId: `cus_${createId()}` });
  createdUsers.push(user.id);
  if (priceId) await db.insert(subscriptions).values({
    userId: user.id, stripeSubscriptionId: `sub_${createId()}`, stripePriceId: priceId, status: 'active',
    currentPeriodStart: new Date('2026-10-01'), currentPeriodEnd: new Date('2026-11-01'),
  });
  return user;
}

describe('strict price reconciliation against PostgreSQL', () => {
  beforeAll(() => { process.env.DEPLOYMENT_MODE = 'cloud'; });
  afterAll(async () => {
    if (priorMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = priorMode;
    if (!createdUsers.length) return;
    await db.delete(creditLedger).where(inArray(creditLedger.userId, createdUsers));
    await db.delete(wallets).where(inArray(wallets.userId, createdUsers));
    await db.delete(users).where(inArray(users.id, createdUsers));
  });

  it.each(['price_retired', undefined])('SEAT-2 (partial) revokes a paid cache without configured price evidence (%s)', async (priceId) => {
    const user = await subscriber(priceId);
    const result = await reconcileSubscriptionTiers({ priceTier });
    const [stored] = await db.select().from(users).where(eq(users.id, user.id));
    expect(stored.subscriptionTier).toBe('free');
    expect(result.details).toContainEqual(expect.objectContaining({ userId: user.id, expectedTier: 'free', repaired: true }));
    expect((await reconcileSubscriptionTiers({ priceTier })).details).not.toContainEqual(expect.objectContaining({ userId: user.id }));
  });

  it('SEAT-2 (partial) a user-scoped sweep repairs only its named users, leaving the rest of the table to the full cron', async () => {
    const inScope = await subscriber();
    const outOfScope = await subscriber();
    const result = await reconcileSubscriptionTiers({ priceTier, userIds: [inScope.id] });
    expect(result.details.map(d => d.userId)).toEqual([inScope.id]);
    const [scoped] = await db.select().from(users).where(eq(users.id, inScope.id));
    expect(scoped.subscriptionTier).toBe('free');
    const [unscoped] = await db.select().from(users).where(eq(users.id, outOfScope.id));
    expect(unscoped.subscriptionTier).toBe('pro');
  });

  it('SEAT-2 (partial) a concurrent price replacement cannot restore stale Pro access', async () => {
    const observedPrice = `price_${createId()}`;
    const user = await subscriber(observedPrice);
    await db.update(users).set({ subscriptionTier: 'free' }).where(eq(users.id, user.id));
    let markLocked!: () => void;
    let markObserved!: () => void;
    const locked = new Promise<void>((resolve) => { markLocked = resolve; });
    const observed = new Promise<void>((resolve) => { markObserved = resolve; });
    const webhook = db.transaction(async (tx) => {
      await tx.select().from(users).where(eq(users.id, user.id)).for('update');
      markLocked();
      await observed;
      await tx.update(subscriptions).set({ stripePriceId: 'price_unknown_replacement' })
        .where(eq(subscriptions.userId, user.id));
      await tx.update(users).set({ subscriptionTier: 'free', updatedAt: new Date() })
        .where(eq(users.id, user.id));
    });
    await locked;
    const sweep = reconcileSubscriptionTiers({ priceTier: (id) => {
      if (id === observedPrice) { markObserved(); return 'pro'; }
      return priceTier(id);
    } });
    await Promise.all([webhook, sweep]);
    const [stored] = await db.select().from(users).where(eq(users.id, user.id));
    expect(stored.subscriptionTier).toBe('free');
  });

  it.each(['free', 'business', undefined] as const)('MON-2 (partial) unverified invoice identity (%s) cannot become a grant through a stale Pro subscription', async (tier) => {
    const user = await subscriber('price_verified_pro');
    const [wallet] = await db.insert(wallets).values({
      ownerType: 'user', userId: user.id, monthlyRemainingCents: 123, topupRemainingCents: 456,
    }).returning();
    const invoiceId = `in_${createId()}`;
    await applyStripeFunding({ id: `evt_${createId()}`, type: 'invoice.paid', data: { object: {
      id: invoiceId, customer: user.stripeCustomerId, amount_paid: 1500, billing_reason: 'subscription_cycle',
      parent: { subscription_details: { subscription: 'sub_unknown_price' } },
    } } }, tier === undefined ? undefined : { tier });
    await reconcileMissedGrants({ priceTier });
    expect(await db.select().from(creditLedger).where(eq(creditLedger.stripeRef, invoiceId))).toEqual([]);
    const [after] = await db.select().from(wallets).where(eq(wallets.id, wallet.id));
    expect(after).toEqual(wallet);
  });

  it.each(['tenant', 'onprem'])('SEAT-6 (partial) Stripe reconciliation cannot revoke %s entitlements', async (mode) => {
    const user = await subscriber();
    process.env.DEPLOYMENT_MODE = mode;
    try {
      expect(await reconcileSubscriptionTiers({ priceTier })).toMatchObject({ scanned: 0, repaired: 0 });
      const [stored] = await db.select().from(users).where(eq(users.id, user.id));
      expect(stored.subscriptionTier).toBe('pro');
    } finally {
      process.env.DEPLOYMENT_MODE = 'cloud';
    }
  });

  it('SEAT-2 (partial) dry-run reports unverified paid access without writes and preserves verified Pro', async () => {
    const unknown = await subscriber('price_retired');
    const valid = await subscriber('price_verified_pro');
    const result = await reconcileSubscriptionTiers({ priceTier, repair: false });
    expect(result.details).toContainEqual(expect.objectContaining({ userId: unknown.id, expectedTier: 'free', repaired: false }));
    expect(result.details).not.toContainEqual(expect.objectContaining({ userId: valid.id }));
    const rows = await db.select().from(users).where(inArray(users.id, [unknown.id, valid.id]));
    expect(rows.map((user) => user.subscriptionTier)).toEqual(['pro', 'pro']);
  });
});
