/**
 * App Store purchases against a REAL Postgres: a verified transaction lands in the same
 * personal root wallet and the same users.subscriptionTier a Stripe purchase does,
 * exactly once, and a refund takes back exactly what it granted. Every row is deleted.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray, like } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { creditLedger } from '@pagespace/db/schema/credits';
import { wallets, personalRootWalletOf } from '@pagespace/db/schema/wallets';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { appStoreSubscriptions, appStoreTransactions, appStoreAccounts } from '@pagespace/db/schema/app-store';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { applyAppleNotification, applyAppleTransaction, type AppleApplyConfig } from '../apple-funding';
import { getOrCreateAccountToken } from '../apple-account';
import { hasRenewableAppleSubscription } from '../apple-entitlement';
import type { DecodedTransactionLike } from '../apple-core';
import type { VerifiedNotification } from '../apple-verify';
import type { SubscriptionTier } from '../../subscription-tiers';

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;
const DAY = 86_400_000;
const config: AppleApplyConfig = { bundleId: 'ai.pagespace.ios', allowSandbox: true };
const priceTier = (priceId: string): SubscriptionTier => (priceId === 'price_test_pro' ? 'pro' : 'free');

let userIds: string[] = [];
let txnPrefix = '';
let seq = 0;
const nextTxnId = () => `${txnPrefix}${String(++seq).padStart(4, '0')}`;

async function newUser(): Promise<{ id: string; token: string }> {
  const user = await factories.createUser({ subscriptionTier: 'free' });
  userIds.push(user.id);
  return { id: user.id, token: await getOrCreateAccountToken(user.id) };
}

function subscriptionTxn(token: string | null, overrides: Partial<DecodedTransactionLike> & { originalTransactionId: string }): DecodedTransactionLike {
  const now = Date.now();
  return {
    transactionId: nextTxnId(),
    productId: 'ai.pagespace.ios.pro.monthly',
    bundleId: 'ai.pagespace.ios',
    environment: 'Sandbox',
    purchaseDate: now - DAY,
    expiresDate: now + 29 * DAY,
    price: 17_990,
    currency: 'USD',
    storefront: 'USA',
    inAppOwnershipType: 'PURCHASED',
    ...(token ? { appAccountToken: token } : {}),
    ...overrides,
  };
}

function packTxn(token: string, credits: 100 | 250 | 500, overrides: Partial<DecodedTransactionLike> = {}): DecodedTransactionLike {
  const transactionId = nextTxnId();
  return {
    transactionId,
    originalTransactionId: transactionId,
    productId: `ai.pagespace.ios.credits.${credits}`,
    bundleId: 'ai.pagespace.ios',
    environment: 'Sandbox',
    purchaseDate: Date.now() - 1000,
    price: 11_990,
    currency: 'USD',
    appAccountToken: token,
    inAppOwnershipType: 'PURCHASED',
    ...overrides,
  };
}

async function root(userId: string) {
  const [w] = await db.select().from(wallets).where(personalRootWalletOf(userId));
  return w;
}

async function tierOf(userId: string) {
  const [u] = await db.select({ tier: users.subscriptionTier }).from(users).where(eq(users.id, userId));
  return u.tier;
}

async function ledgerFor(userId: string) {
  return db.select().from(creditLedger).where(eq(creditLedger.userId, userId));
}

beforeAll(async () => {
  try {
    await db.select({ id: appStoreAccounts.userId }).from(appStoreAccounts).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('apple-funding.integration.test.ts', error);
  }
});

beforeEach(() => {
  process.env.DEPLOYMENT_MODE = 'cloud';
  userIds = [];
  txnPrefix = `9${Date.now()}${Math.floor(Math.random() * 1000)}`;
  seq = 0;
});

afterEach(async () => {
  if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
  else process.env.DEPLOYMENT_MODE = originalMode;
  if (!dbAvailable) return;
  await db.delete(appStoreTransactions).where(like(appStoreTransactions.transactionId, `${txnPrefix}%`));
  if (userIds.length > 0) {
    await db.delete(creditLedger).where(inArray(creditLedger.userId, userIds));
    await db.delete(subscriptions).where(inArray(subscriptions.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
});

afterAll(async () => {
  if (dbAvailable) await pool.end();
});

describe('an App Store Pro subscription', () => {
  it('grants Pro and exactly the web Pro allowance, sized from the web price, once', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const original = nextTxnId();
    const txn = subscriptionTxn(u.token, { originalTransactionId: original, transactionId: original });

    const first = await applyAppleTransaction({ userId: u.id, decoded: txn, priceTier, config });
    expect(first).toEqual({ result: 'applied', kind: 'subscription', subscriptionTier: 'pro' });
    expect(await tierOf(u.id)).toBe('pro');
    expect(await root(u.id)).toMatchObject({ monthlyRemainingCents: 900, monthlyAllowanceCents: 900 });
    const [grant] = await ledgerFor(u.id);
    expect(grant).toMatchObject({ entryType: 'monthly_grant', amountCents: 900, paidCents: 1500, stripeRef: `apple:${original}`, consumeStatus: 'applied' });

    const again = await applyAppleTransaction({ userId: u.id, decoded: txn, priceTier, config });
    expect(again).toEqual({ result: 'duplicate', kind: 'subscription', subscriptionTier: 'pro' });
    expect((await root(u.id)).monthlyRemainingCents).toBe(900);
    expect(await ledgerFor(u.id)).toHaveLength(1);

    const [sub] = await db.select().from(appStoreSubscriptions).where(eq(appStoreSubscriptions.originalTransactionId, original));
    expect(sub).toMatchObject({ userId: u.id, status: 'active', environment: 'Sandbox', latestTransactionId: original });
    const [record] = await db.select().from(appStoreTransactions).where(eq(appStoreTransactions.transactionId, original));
    expect(record).toMatchObject({ priceMilliunits: 17_990, currency: 'USD', productKind: 'subscription', revokedAt: null });
    expect(await hasRenewableAppleSubscription(db, u.id, new Date())).toBe(true);
  });

  it('a renewal grants again and moves the period forward; an older period arriving late does not rewind it', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const original = nextTxnId();
    const now = Date.now();
    const firstPeriod = subscriptionTxn(u.token, { originalTransactionId: original, transactionId: original, purchaseDate: now - 31 * DAY, expiresDate: now - DAY });
    const renewal = subscriptionTxn(u.token, { originalTransactionId: original, purchaseDate: now - DAY, expiresDate: now + 29 * DAY });

    await applyAppleTransaction({ userId: u.id, decoded: renewal, priceTier, config });
    await applyAppleTransaction({ userId: u.id, decoded: firstPeriod, priceTier, config });

    const [sub] = await db.select().from(appStoreSubscriptions).where(eq(appStoreSubscriptions.originalTransactionId, original));
    expect(sub.latestTransactionId).toBe(renewal.transactionId);
    expect(sub.status).toBe('active');
    expect(await tierOf(u.id)).toBe('pro');
    const grants = (await ledgerFor(u.id)).filter((r) => r.entryType === 'monthly_grant');
    expect(grants).toHaveLength(2);
    expect((await root(u.id)).monthlyRemainingCents).toBe(1800);
  });

  it('an EXPIRED notification drops the tier to free; a missed one cannot hold it open past expiry', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const original = nextTxnId();
    const now = Date.now();
    const txn = subscriptionTxn(u.token, { originalTransactionId: original, transactionId: original });
    await applyAppleTransaction({ userId: u.id, decoded: txn, priceTier, config });

    const expired: VerifiedNotification = {
      notificationUUID: createId(), type: 'EXPIRED', subtype: 'VOLUNTARY', status: 2,
      transaction: txn, renewal: { autoRenew: false, gracePeriodExpiresMs: null },
    };
    expect(await applyAppleNotification({ notification: expired, priceTier, config })).toMatchObject({ subscriptionTier: 'free' });
    expect(await tierOf(u.id)).toBe('free');

    // A different user whose period simply ran out with no notification at all.
    const v = await newUser();
    const stale = nextTxnId();
    await applyAppleTransaction({
      userId: v.id,
      decoded: subscriptionTxn(v.token, { originalTransactionId: stale, transactionId: stale, purchaseDate: now - 31 * DAY, expiresDate: now - DAY }),
      priceTier, config,
    });
    expect(await tierOf(v.id)).toBe('free');
  });

  it('a refund of the current period revokes Pro and claws back that period\'s grant, the rest as debt', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const original = nextTxnId();
    const txn = subscriptionTxn(u.token, { originalTransactionId: original, transactionId: original });
    await applyAppleTransaction({ userId: u.id, decoded: txn, priceTier, config });
    await db.update(wallets).set({ monthlyRemainingCents: 300, topupRemainingCents: 100 }).where(personalRootWalletOf(u.id));

    const refunded = { ...txn, revocationDate: Date.now(), revocationReason: 0 };
    const result = await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'REFUND', subtype: null, status: 5, transaction: refunded, renewal: null },
      priceTier, config,
    });
    expect(result).toMatchObject({ result: 'applied', kind: 'revoked', subscriptionTier: 'free' });
    expect(await root(u.id)).toMatchObject({ monthlyRemainingCents: 0, topupRemainingCents: 0, debtCents: 500 });
    const rows = (await ledgerFor(u.id)).filter((r) => r.entryType === 'adjustment');
    expect(rows.map((r) => [r.amountCents, r.appliedCents, r.stripeRef]).sort()).toEqual([[-400, -400, `apple-refund:${original}`], [-500, null, null]].sort());

    // Redelivered refund: nothing more.
    await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'REFUND', subtype: null, status: 5, transaction: refunded, renewal: null },
      priceTier, config,
    });
    expect((await root(u.id)).debtCents).toBe(500);
  });
});

describe('App Store credit packs', () => {
  it('pays outstanding debt first, then credits the top-up bucket, exactly once', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    await db.insert(wallets).values({ userId: u.id, debtCents: 300 });
    const txn = packTxn(u.token, 250);

    expect(await applyAppleTransaction({ userId: u.id, decoded: txn, priceTier, config })).toEqual({ result: 'applied', kind: 'consumable', subscriptionTier: 'free' });
    expect(await root(u.id)).toMatchObject({ topupRemainingCents: 2200, debtCents: 0 });
    expect(await applyAppleTransaction({ userId: u.id, decoded: txn, priceTier, config })).toMatchObject({ result: 'duplicate' });
    expect((await root(u.id)).topupRemainingCents).toBe(2200);
    const [purchase] = (await ledgerFor(u.id)).filter((r) => r.entryType === 'topup_purchase');
    expect(purchase).toMatchObject({ amountCents: 2500, stripeRef: `apple:${txn.transactionId}` });
  });

  it('a refund takes the pack back out of top-up first; a reversed refund puts it back once', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const txn = packTxn(u.token, 100);
    await applyAppleTransaction({ userId: u.id, decoded: txn, priceTier, config });
    expect((await root(u.id)).topupRemainingCents).toBe(1000);

    const refund: VerifiedNotification = { notificationUUID: createId(), type: 'REFUND', subtype: null, status: null, transaction: { ...txn, revocationDate: Date.now() }, renewal: null };
    await applyAppleNotification({ notification: refund, priceTier, config });
    expect((await root(u.id)).topupRemainingCents).toBe(0);

    const reversed: VerifiedNotification = { notificationUUID: createId(), type: 'REFUND_REVERSED', subtype: null, status: null, transaction: txn, renewal: null };
    await applyAppleNotification({ notification: reversed, priceTier, config });
    await applyAppleNotification({ notification: { ...reversed, notificationUUID: createId() }, priceTier, config });
    expect((await root(u.id)).topupRemainingCents).toBe(1000);
    const refs = (await ledgerFor(u.id)).map((r) => r.stripeRef).filter(Boolean).sort();
    expect(refs).toEqual([`apple-refund:${txn.transactionId}`, `apple-reinstate:${txn.transactionId}`, `apple:${txn.transactionId}`].sort());
  });

  it('a refund for a pack we never funded takes nothing', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const txn = { ...packTxn(u.token, 500), revocationDate: Date.now() };
    await applyAppleTransaction({ userId: u.id, decoded: txn, priceTier, config });
    expect(await ledgerFor(u.id)).toHaveLength(0);
  });
});

describe('who a transaction belongs to', () => {
  it("refuses a transaction carrying another user's account token and writes nothing", async () => {
    if (!dbAvailable) return;
    const buyer = await newUser();
    const replayer = await newUser();
    const txn = packTxn(buyer.token, 500);
    expect(await applyAppleTransaction({ userId: replayer.id, decoded: txn, priceTier, config })).toEqual({ result: 'refused', reason: 'account_mismatch' });
    expect(await ledgerFor(replayer.id)).toHaveLength(0);
    expect(await db.select().from(appStoreTransactions).where(eq(appStoreTransactions.transactionId, txn.transactionId!))).toHaveLength(0);
  });

  it('refuses to move a subscription another user already owns', async () => {
    if (!dbAvailable) return;
    const owner = await newUser();
    const other = await newUser();
    const original = nextTxnId();
    await applyAppleTransaction({ userId: owner.id, decoded: subscriptionTxn(owner.token, { originalTransactionId: original, transactionId: original }), priceTier, config });
    const renewalWithoutToken = subscriptionTxn(null, { originalTransactionId: original });
    expect(await applyAppleTransaction({ userId: other.id, decoded: renewalWithoutToken, priceTier, config })).toEqual({ result: 'refused', reason: 'owned_by_another_user' });
  });

  it('routes a notification by its account token, or by the subscription on file when it has none', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const original = nextTxnId();
    await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'SUBSCRIBED', subtype: 'INITIAL_BUY', status: 1, transaction: subscriptionTxn(u.token, { originalTransactionId: original, transactionId: original }), renewal: { autoRenew: true, gracePeriodExpiresMs: null } },
      priceTier, config,
    });
    expect(await tierOf(u.id)).toBe('pro');

    const tokenless = subscriptionTxn(null, { originalTransactionId: original });
    expect(await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'DID_RENEW', subtype: null, status: 1, transaction: tokenless, renewal: { autoRenew: false, gracePeriodExpiresMs: null } },
      priceTier, config,
    })).toMatchObject({ result: 'applied' });
    const [sub] = await db.select().from(appStoreSubscriptions).where(eq(appStoreSubscriptions.originalTransactionId, original));
    expect(sub).toMatchObject({ latestTransactionId: tokenless.transactionId, autoRenew: false });
  });

  it('refuses a notification whose buyer it cannot find', async () => {
    if (!dbAvailable) return;
    const original = nextTxnId();
    expect(await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'DID_RENEW', subtype: null, status: 1, transaction: subscriptionTxn(null, { originalTransactionId: original, transactionId: original }), renewal: null },
      priceTier, config,
    })).toEqual({ result: 'refused', reason: 'unknown_user' });
  });

  it('refuses Sandbox money when the deployment does not allow it', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    expect(await applyAppleTransaction({ userId: u.id, decoded: packTxn(u.token, 100), priceTier, config: { ...config, allowSandbox: false } }))
      .toEqual({ result: 'refused', reason: 'sandbox_refused' });
  });

  it('does nothing where billing is off (tenant / onprem)', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    process.env.DEPLOYMENT_MODE = 'onprem';
    expect(await applyAppleTransaction({ userId: u.id, decoded: packTxn(u.token, 100), priceTier, config })).toEqual({ result: 'refused', reason: 'not_billing' });
  });
});

describe('one plan whichever store sold it', () => {
  async function stripePro(userId: string, status = 'active') {
    await db.insert(subscriptions).values({
      userId,
      stripeSubscriptionId: `sub_${createId()}`,
      stripePriceId: 'price_test_pro',
      status,
      currentPeriodStart: new Date(Date.now() - DAY),
      currentPeriodEnd: new Date(Date.now() + 29 * DAY),
    });
  }

  it('an expired App Store plan does not demote an active Stripe Pro', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    await stripePro(u.id);
    const original = nextTxnId();
    const now = Date.now();
    await applyAppleTransaction({
      userId: u.id,
      decoded: subscriptionTxn(u.token, { originalTransactionId: original, transactionId: original, purchaseDate: now - 31 * DAY, expiresDate: now - DAY }),
      priceTier, config,
    });
    expect(await tierOf(u.id)).toBe('pro');
  });

  it('a canceled Stripe plan and an active App Store plan still make Pro', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    await stripePro(u.id, 'canceled');
    const original = nextTxnId();
    await applyAppleTransaction({ userId: u.id, decoded: subscriptionTxn(u.token, { originalTransactionId: original, transactionId: original }), priceTier, config });
    expect(await tierOf(u.id)).toBe('pro');
    const ledger = await db.select().from(creditLedger).where(and(eq(creditLedger.userId, u.id), eq(creditLedger.entryType, 'monthly_grant')));
    expect(ledger).toHaveLength(1);
  });
});

describe('the sweeps see App Store plans', () => {
  it('the hourly comped-root sweep leaves an App Store subscriber to Apple\'s renewal, and rolls a lapsed one', async () => {
    if (!dbAvailable) return;
    const { rollDuePersonalRoots } = await import('../../wallet-funding-shell');
    const u = await newUser();
    const original = nextTxnId();
    await applyAppleTransaction({ userId: u.id, decoded: subscriptionTxn(u.token, { originalTransactionId: original, transactionId: original }), priceTier, config });
    // Its root period has ended (renewal not yet in), but Apple may still renew it.
    await db.update(wallets).set({ monthlyPeriodEnd: new Date(Date.now() - 1000) }).where(personalRootWalletOf(u.id));
    await rollDuePersonalRoots({ now: new Date() });
    expect((await ledgerFor(u.id)).filter((r) => r.entryType === 'monthly_grant')).toHaveLength(1);

    // Revoked long ago: no renewal will come, so a still-Pro cache is a comped account.
    await db.update(appStoreSubscriptions).set({ status: 'expired' }).where(eq(appStoreSubscriptions.originalTransactionId, original));
    await rollDuePersonalRoots({ now: new Date() });
    expect((await ledgerFor(u.id)).filter((r) => r.entryType === 'monthly_grant')).toHaveLength(2);
  });

  it('the tier reconciler restores an App Store Pro the cache lost, and drops one whose period ended', async () => {
    if (!dbAvailable) return;
    const { reconcileSubscriptionTiers } = await import('../../subscription-tier-reconcile');
    const u = await newUser();
    const original = nextTxnId();
    await applyAppleTransaction({ userId: u.id, decoded: subscriptionTxn(u.token, { originalTransactionId: original, transactionId: original }), priceTier, config });
    await db.update(users).set({ subscriptionTier: 'free' }).where(eq(users.id, u.id));

    const restored = await reconcileSubscriptionTiers({ priceTier, userIds: [u.id] });
    expect(restored).toMatchObject({ drifted: 1, repaired: 1 });
    expect(await tierOf(u.id)).toBe('pro');

    await db.update(appStoreSubscriptions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(appStoreSubscriptions.originalTransactionId, original));
    const lapsed = await reconcileSubscriptionTiers({ priceTier, userIds: [u.id] });
    expect(lapsed).toMatchObject({ repaired: 1 });
    expect(await tierOf(u.id)).toBe('free');
  });
});
