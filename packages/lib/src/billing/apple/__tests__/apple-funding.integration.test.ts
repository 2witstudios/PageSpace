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
import { walletDriftAlerts } from '../../wallet-reconcile';
import { hasRenewableStripeSubscription } from '../../wallet-funding-shell';
import type { DecodedTransactionLike } from '../apple-core';
import type { VerifiedNotification } from '../apple-verify';
import type { SubscriptionTier } from '../../subscription-tiers';

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;
const DAY = 86_400_000;
const config: AppleApplyConfig = { bundleId: 'ai.pagespace.ios', allowSandbox: true, sandboxMaxFundings: 100, sandboxAllowlist: [] };
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
    signedDate: now,
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
    signedDate: Date.now() - 1000,
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

/** Spend everything in the root through the ledger, so the books still reconcile. */
async function spendAll(userId: string) {
  const w = await root(userId);
  const spent = w.monthlyRemainingCents + w.topupRemainingCents;
  await db.insert(creditLedger).values({ userId, walletId: w.id, entryType: 'adjustment', bucket: 'monthly', amountCents: -spent, appliedCents: -spent, consumeStatus: 'applied' });
  await db.update(wallets).set({ monthlyRemainingCents: 0, topupRemainingCents: 0 }).where(personalRootWalletOf(userId));
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

    const first = await applyAppleTransaction({ source: 'device', userId: u.id, decoded: txn, priceTier, config });
    expect(first).toEqual({ result: 'applied', kind: 'subscription', subscriptionTier: 'pro' });
    expect(await tierOf(u.id)).toBe('pro');
    expect(await root(u.id)).toMatchObject({ monthlyRemainingCents: 900, monthlyAllowanceCents: 900 });
    const [grant] = await ledgerFor(u.id);
    expect(grant).toMatchObject({ entryType: 'monthly_grant', amountCents: 900, paidCents: 1500, stripeRef: `apple:${original}`, consumeStatus: 'applied' });

    const again = await applyAppleTransaction({ source: 'device', userId: u.id, decoded: txn, priceTier, config });
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

    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: renewal, priceTier, config });
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: firstPeriod, priceTier, config });

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
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: txn, priceTier, config });

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
      source: 'device',
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
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: txn, priceTier, config });
    await db.update(wallets).set({ monthlyRemainingCents: 300, topupRemainingCents: 100 }).where(personalRootWalletOf(u.id));

    const refunded = { ...txn, revocationDate: Date.now(), revocationReason: 0, signedDate: Date.now() + 1 };
    const result = await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'REFUND', subtype: null, status: 5, transaction: refunded, renewal: null },
      priceTier, config,
    });
    expect(result).toMatchObject({ result: 'applied', kind: 'revoked', subscriptionTier: 'free' });
    expect(await root(u.id)).toMatchObject({ monthlyRemainingCents: 0, topupRemainingCents: 0, debtCents: 500 });
    const rows = (await ledgerFor(u.id)).filter((r) => r.entryType === 'adjustment');
    expect(rows.map((r) => [r.amountCents, r.appliedCents, r.stripeRef]).sort()).toEqual([[-400, -400, `apple-refund:${original}:${refunded.revocationDate}`], [-500, null, null]].sort());

    // Redelivered refund: nothing more.
    await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'REFUND', subtype: null, status: 5, transaction: refunded, renewal: null },
      priceTier, config,
    });
    expect((await root(u.id)).debtCents).toBe(500);
  });
});

describe('App Store subscription state follows Apple, not arrival order', () => {
  it('a refunded period cannot be restored to Pro by replaying its pre-refund receipt', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const original = nextTxnId();
    const txn = subscriptionTxn(u.token, { originalTransactionId: original, transactionId: original });
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: txn, priceTier, config });
    const t1 = Date.now() + 5;
    await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'REFUND', subtype: null, status: 5, transaction: { ...txn, revocationDate: t1, signedDate: t1 }, renewal: null },
      priceTier, config,
    });
    expect(await tierOf(u.id)).toBe('free');

    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: txn, priceTier, config });
    expect(await tierOf(u.id)).toBe('free');
    const [sub] = await db.select().from(appStoreSubscriptions).where(eq(appStoreSubscriptions.originalTransactionId, original));
    expect(sub.status).toBe('revoked');
    expect((await ledgerFor(u.id)).filter((r) => r.entryType === 'monthly_grant')).toHaveLength(1);
  });

  it('a delayed renewal for the next period applies though the previous period\'s refund was signed after it', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const original = nextTxnId();
    const now = Date.now();
    const periodN = subscriptionTxn(u.token, { originalTransactionId: original, transactionId: original, purchaseDate: now - 31 * DAY, expiresDate: now - DAY, signedDate: now - 31 * DAY });
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: periodN, priceTier, config });
    // The refund of period N, signed after Apple signed the renewal below, is delivered first.
    await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'REFUND', subtype: null, status: 5, transaction: { ...periodN, revocationDate: now, signedDate: now + 10 }, renewal: null },
      priceTier, config,
    });
    const renewal = subscriptionTxn(u.token, { originalTransactionId: original, purchaseDate: now - DAY, expiresDate: now + 29 * DAY, signedDate: now });
    await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'DID_RENEW', subtype: null, status: 1, transaction: renewal, renewal: { autoRenew: true, gracePeriodExpiresMs: null } },
      priceTier, config,
    });
    expect(await tierOf(u.id)).toBe('pro');
    const [sub] = await db.select().from(appStoreSubscriptions).where(eq(appStoreSubscriptions.originalTransactionId, original));
    expect(sub).toMatchObject({ status: 'active', latestTransactionId: renewal.transactionId });

    // The refunded period's receipt, replayed, still changes nothing about the current period.
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: { ...periodN, signedDate: now + 20 }, priceTier, config });
    expect(await tierOf(u.id)).toBe('pro');
  });

  it('a delayed renewal moves the period forward without rolling back renewal preferences signed after it', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const original = nextTxnId();
    const now = Date.now();
    const periodN = subscriptionTxn(u.token, { originalTransactionId: original, transactionId: original, purchaseDate: now - 31 * DAY, expiresDate: now - DAY, signedDate: now - 31 * DAY });
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: periodN, priceTier, config });
    await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'REFUND', subtype: null, status: 5, transaction: { ...periodN, revocationDate: now, signedDate: now + 100 }, renewal: { autoRenew: false, gracePeriodExpiresMs: null } },
      priceTier, config,
    });
    const renewal = subscriptionTxn(u.token, { originalTransactionId: original, purchaseDate: now - DAY, expiresDate: now + 29 * DAY, signedDate: now });
    await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'DID_RENEW', subtype: null, status: 1, transaction: renewal, renewal: { autoRenew: true, gracePeriodExpiresMs: null } },
      priceTier, config,
    });
    const [sub] = await db.select().from(appStoreSubscriptions).where(eq(appStoreSubscriptions.originalTransactionId, original));
    expect(sub).toMatchObject({ status: 'active', latestTransactionId: renewal.transactionId, autoRenew: false });
    // The new period's clock starts at its own payload; the preference keeps its own clock.
    expect(sub.lastSignedAt?.getTime()).toBe(now);
    expect(sub.autoRenewSignedAt?.getTime()).toBe(now + 100);
  });

  it('a refund of the new period applies after a delayed renewal, though the previous period\'s refund was signed later', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const original = nextTxnId();
    const now = Date.now();
    const periodN = subscriptionTxn(u.token, { originalTransactionId: original, transactionId: original, purchaseDate: now - 31 * DAY, expiresDate: now - DAY, signedDate: now - 31 * DAY });
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: periodN, priceTier, config });
    await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'REFUND', subtype: null, status: 5, transaction: { ...periodN, revocationDate: now, signedDate: now + 50 }, renewal: null },
      priceTier, config,
    });
    const renewal = subscriptionTxn(u.token, { originalTransactionId: original, purchaseDate: now - DAY, expiresDate: now + 29 * DAY, signedDate: now + 40 });
    await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'DID_RENEW', subtype: null, status: 1, transaction: renewal, renewal: null },
      priceTier, config,
    });
    expect(await tierOf(u.id)).toBe('pro');
    // The new period's refund was signed after its renewal but before period N's refund.
    await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'REFUND', subtype: null, status: 5, transaction: { ...renewal, revocationDate: now + 45, signedDate: now + 45 }, renewal: null },
      priceTier, config,
    });
    const [sub] = await db.select().from(appStoreSubscriptions).where(eq(appStoreSubscriptions.originalTransactionId, original));
    expect(sub.status).toBe('revoked');
    expect(await tierOf(u.id)).toBe('free');
  });

  it('renewal preferences follow signing order even when older-period payloads arrive out of order', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const original = nextTxnId();
    const now = Date.now();
    const periodN = subscriptionTxn(u.token, { originalTransactionId: original, transactionId: original, purchaseDate: now - 31 * DAY, expiresDate: now - DAY, signedDate: now - 31 * DAY });
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: periodN, priceTier, config });
    const renewal = subscriptionTxn(u.token, { originalTransactionId: original, purchaseDate: now - DAY, expiresDate: now + 29 * DAY, signedDate: now });
    await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'DID_RENEW', subtype: null, status: 1, transaction: renewal, renewal: { autoRenew: true, gracePeriodExpiresMs: null } },
      priceTier, config,
    });
    // Two later payloads about the OLDER period, delivered newest first.
    const aboutN = (signedDate: number, autoRenew: boolean): VerifiedNotification => ({
      notificationUUID: createId(), type: 'DID_CHANGE_RENEWAL_STATUS', subtype: null, status: 1, transaction: { ...periodN, signedDate }, renewal: { autoRenew, gracePeriodExpiresMs: null },
    });
    await applyAppleNotification({ notification: aboutN(now + 20, true), priceTier, config });
    await applyAppleNotification({ notification: aboutN(now + 10, false), priceTier, config });
    const [sub] = await db.select().from(appStoreSubscriptions).where(eq(appStoreSubscriptions.originalTransactionId, original));
    expect(sub).toMatchObject({ autoRenew: true, latestTransactionId: renewal.transactionId });
  });

  it('Restore Purchases during a billing grace period keeps Pro (the device cannot see the grace)', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const original = nextTxnId();
    const now = Date.now();
    const lapsed = subscriptionTxn(u.token, { originalTransactionId: original, transactionId: original, purchaseDate: now - 31 * DAY, expiresDate: now - DAY, signedDate: now - 31 * DAY });
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: lapsed, priceTier, config });
    await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'DID_FAIL_TO_RENEW', subtype: 'GRACE_PERIOD', status: 4, transaction: { ...lapsed, signedDate: now - DAY }, renewal: { autoRenew: true, gracePeriodExpiresMs: now + 5 * DAY } },
      priceTier, config,
    });
    expect(await tierOf(u.id)).toBe('pro');

    // StoreKit's current entitlements still hold that transaction, re-signed now.
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: { ...lapsed, signedDate: now }, priceTier, config });
    expect(await tierOf(u.id)).toBe('pro');
    const [sub] = await db.select().from(appStoreSubscriptions).where(eq(appStoreSubscriptions.originalTransactionId, original));
    expect(sub.status).toBe('grace_period');
    expect(sub.expiresAt.getTime()).toBe(now + 5 * DAY);
  });

  it('a token-less subscription (an App Store offer code) is claimed by the first signed-in buyer, never by a notification', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const original = nextTxnId();
    const offer = subscriptionTxn(null, { originalTransactionId: original, transactionId: original });
    expect(await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'OFFER_REDEEMED', subtype: null, status: 1, transaction: offer, renewal: null },
      priceTier, config,
    })).toEqual({ result: 'refused', reason: 'unknown_user' });

    expect(await applyAppleTransaction({ source: 'device', userId: u.id, decoded: offer, priceTier, config })).toMatchObject({ result: 'applied', subscriptionTier: 'pro' });
    const other = await newUser();
    expect(await applyAppleTransaction({ source: 'device', userId: other.id, decoded: { ...offer, signedDate: Date.now() + 1 }, priceTier, config }))
      .toEqual({ result: 'refused', reason: 'owned_by_another_user' });
  });
});

describe('Sandbox money', () => {
  it('funds only a few Sandbox purchases per user, while the purchase still records', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const capped = { ...config, sandboxMaxFundings: 2 };
    for (let i = 0; i < 3; i += 1) {
      await applyAppleTransaction({ source: 'device', userId: u.id, decoded: packTxn(u.token, 100), priceTier, config: capped });
    }
    expect((await root(u.id)).topupRemainingCents).toBe(2000);
    expect(await db.select().from(appStoreTransactions).where(eq(appStoreTransactions.userId, u.id))).toHaveLength(3);
  });

  it('a backlog of capped purchases replayed after the window funds only up to the cap again', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const capped = { ...config, sandboxMaxFundings: 3 };
    const packs = Array.from({ length: 8 }, () => packTxn(u.token, 100));
    for (const pack of packs) await applyAppleTransaction({ source: 'device', userId: u.id, decoded: pack, priceTier, config: capped });
    expect((await root(u.id)).topupRemainingCents).toBe(3000);

    const later = new Date(Date.now() + 31 * DAY);
    for (const pack of packs) await applyAppleTransaction({ source: 'device', userId: u.id, decoded: pack, priceTier, config: capped, now: later });
    expect((await root(u.id)).topupRemainingCents).toBe(6000);
  });

  it('a stale copy of a capped purchase that funds later still counts toward the cap', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const capped = { ...config, sandboxMaxFundings: 1 };
    const signed = Date.now();
    const first = packTxn(u.token, 100);
    const second = packTxn(u.token, 100, { signedDate: signed });
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: first, priceTier, config: capped });
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: second, priceTier, config: capped });
    expect((await root(u.id)).topupRemainingCents).toBe(1000);

    // After the window: an older-signed copy of the capped purchase funds it...
    const later = new Date(Date.now() + 31 * DAY);
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: { ...second, signedDate: signed - 10 }, priceTier, config: capped, now: later });
    expect((await root(u.id)).topupRemainingCents).toBe(2000);
    const [row] = await db.select().from(appStoreTransactions).where(eq(appStoreTransactions.transactionId, String(second.transactionId)));
    expect(row.fundedAt?.getTime()).toBe(later.getTime());
    // ...and that funding counts: the next one in the same window is capped.
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: packTxn(u.token, 100), priceTier, config: capped, now: later });
    expect((await root(u.id)).topupRemainingCents).toBe(2000);
  });

  it('a backlog of capped purchases replayed as stale receipts in the next window funds only up to the cap', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const capped = { ...config, sandboxMaxFundings: 1 };
    const signed = Date.now();
    const packs = Array.from({ length: 5 }, () => packTxn(u.token, 100, { signedDate: signed }));
    for (const pack of packs) await applyAppleTransaction({ source: 'device', userId: u.id, decoded: pack, priceTier, config: capped });
    expect((await root(u.id)).topupRemainingCents).toBe(1000);

    const later = new Date(Date.now() + 31 * DAY);
    for (const pack of packs) {
      await applyAppleTransaction({ source: 'device', userId: u.id, decoded: { ...pack, signedDate: signed - 10 }, priceTier, config: capped, now: later });
    }
    expect((await root(u.id)).topupRemainingCents).toBe(2000);
  });

  it('funds an allowlisted tester past the cap, and never caps real money', async () => {
    if (!dbAvailable) return;
    const tester = await newUser();
    const buyer = await newUser();
    for (let i = 0; i < 2; i += 1) {
      await applyAppleTransaction({ source: 'device', userId: tester.id, decoded: packTxn(tester.token, 100), priceTier, config: { ...config, sandboxMaxFundings: 1, sandboxAllowlist: [tester.id] } });
    }
    expect((await root(tester.id)).topupRemainingCents).toBe(2000);
    const prodConfig = { ...config, sandboxMaxFundings: 0 };
    await applyAppleTransaction({ source: 'device', userId: buyer.id, decoded: packTxn(buyer.token, 100, { environment: 'Production' }), priceTier, config: prodConfig });
    expect((await root(buyer.id)).topupRemainingCents).toBe(1000);
  });
});

describe('App Store credit packs', () => {
  it('pays outstanding debt first, then credits the top-up bucket, exactly once', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    await db.insert(wallets).values({ userId: u.id, debtCents: 300 });
    const txn = packTxn(u.token, 250);

    expect(await applyAppleTransaction({ source: 'device', userId: u.id, decoded: txn, priceTier, config })).toEqual({ result: 'applied', kind: 'consumable', subscriptionTier: 'free' });
    expect(await root(u.id)).toMatchObject({ topupRemainingCents: 2200, debtCents: 0 });
    expect(await applyAppleTransaction({ source: 'device', userId: u.id, decoded: txn, priceTier, config })).toMatchObject({ result: 'duplicate' });
    expect((await root(u.id)).topupRemainingCents).toBe(2200);
    const [purchase] = (await ledgerFor(u.id)).filter((r) => r.entryType === 'topup_purchase');
    expect(purchase).toMatchObject({ amountCents: 2500, stripeRef: `apple:${txn.transactionId}` });
  });

  it('a refund takes the pack back out of top-up first; a reversed refund puts it back once; a second refund takes it again', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const txn = packTxn(u.token, 100);
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: txn, priceTier, config });
    expect((await root(u.id)).topupRemainingCents).toBe(1000);

    const t0 = Date.now();
    const refund: VerifiedNotification = { notificationUUID: createId(), type: 'REFUND', subtype: null, status: null, transaction: { ...txn, revocationDate: t0, signedDate: t0 }, renewal: null };
    await applyAppleNotification({ notification: refund, priceTier, config });
    expect((await root(u.id)).topupRemainingCents).toBe(0);

    const reversed: VerifiedNotification = { notificationUUID: createId(), type: 'REFUND_REVERSED', subtype: null, status: null, transaction: { ...txn, signedDate: t0 + 10 }, renewal: null };
    await applyAppleNotification({ notification: reversed, priceTier, config });
    await applyAppleNotification({ notification: { ...reversed, notificationUUID: createId() }, priceTier, config });
    expect((await root(u.id)).topupRemainingCents).toBe(1000);

    const again: VerifiedNotification = { notificationUUID: createId(), type: 'REFUND', subtype: null, status: null, transaction: { ...txn, revocationDate: t0 + 20, signedDate: t0 + 20 }, renewal: null };
    await applyAppleNotification({ notification: again, priceTier, config });
    expect((await root(u.id)).topupRemainingCents).toBe(0);
    const refs = (await ledgerFor(u.id)).map((r) => r.stripeRef).filter(Boolean).sort();
    expect(refs).toEqual([
      `apple-refund:${txn.transactionId}:${t0}`,
      `apple-refund:${txn.transactionId}:${t0 + 20}`,
      `apple-reinstate:${txn.transactionId}:${t0}`,
      `apple:${txn.transactionId}`,
    ].sort());
  });

  it('reversing one refund restores only that grant: unrelated debt stays owed', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const original = nextTxnId();
    const sub = subscriptionTxn(u.token, { originalTransactionId: original, transactionId: original });
    const pack = packTxn(u.token, 500);
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: sub, priceTier, config });
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: pack, priceTier, config });
    await spendAll(u.id);

    const t0 = Date.now() + 5;
    await applyAppleNotification({ notification: { notificationUUID: createId(), type: 'REFUND', subtype: null, status: 5, transaction: { ...sub, revocationDate: t0, signedDate: t0 }, renewal: null }, priceTier, config });
    await applyAppleNotification({ notification: { notificationUUID: createId(), type: 'REFUND', subtype: null, status: null, transaction: { ...pack, revocationDate: t0, signedDate: t0 }, renewal: null }, priceTier, config });
    expect((await root(u.id)).debtCents).toBe(5900);

    await applyAppleNotification({ notification: { notificationUUID: createId(), type: 'REFUND_REVERSED', subtype: null, status: 1, transaction: { ...sub, signedDate: t0 + 10 }, renewal: null }, priceTier, config });
    expect(await root(u.id)).toMatchObject({ debtCents: 5000, monthlyRemainingCents: 0, topupRemainingCents: 0 });
    expect((await ledgerFor(u.id)).filter((r) => r.entryType === 'debt_forgiven')).toHaveLength(0);
    // The restore row moves exactly what the wallet gained: the books still reconcile.
    expect(await walletDriftAlerts({ toleranceCents: 0, limit: 10, walletIds: [(await root(u.id)).id] })).toEqual([]);
  });

  it('a refunded pack cannot be re-credited by replaying its pre-refund receipt, or by any payload that is not a REFUND_REVERSED notification', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const txn = packTxn(u.token, 500);
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: txn, priceTier, config });
    const t0 = Date.now();
    await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'REFUND', subtype: null, status: null, transaction: { ...txn, revocationDate: t0, signedDate: t0 }, renewal: null },
      priceTier, config,
    });
    expect((await root(u.id)).topupRemainingCents).toBe(0);

    // The original receipt, replayed from the device.
    expect(await applyAppleTransaction({ source: 'device', userId: u.id, decoded: txn, priceTier, config })).toMatchObject({ result: 'duplicate' });
    // A freshly signed unrevoked payload from the device, or a notification of another type.
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: { ...txn, signedDate: t0 + 50 }, priceTier, config });
    await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'ONE_TIME_CHARGE', subtype: null, status: null, transaction: { ...txn, signedDate: t0 + 60 }, renewal: null },
      priceTier, config,
    });
    expect((await root(u.id)).topupRemainingCents).toBe(0);
    const [record] = await db.select().from(appStoreTransactions).where(eq(appStoreTransactions.transactionId, txn.transactionId!));
    expect(record.revokedAt?.getTime()).toBe(t0);
  });

  it('a refund claws back — and a reversal re-grants — what the purchase was credited, not today\'s catalog figure', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const txn = packTxn(u.token, 100);
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: txn, priceTier, config });
    // As if the pack had granted 1200¢ when it was bought (the catalog has since changed to 1000¢).
    await db.update(creditLedger).set({ amountCents: 1200 }).where(eq(creditLedger.stripeRef, `apple:${txn.transactionId}`));
    await db.update(wallets).set({ topupRemainingCents: 1200 }).where(personalRootWalletOf(u.id));

    const t0 = Date.now();
    await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'REFUND', subtype: null, status: null, transaction: { ...txn, revocationDate: t0, signedDate: t0 }, renewal: null },
      priceTier, config,
    });
    expect(await root(u.id)).toMatchObject({ topupRemainingCents: 0, debtCents: 0 });

    await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'REFUND_REVERSED', subtype: null, status: null, transaction: { ...txn, signedDate: t0 + 1 }, renewal: null },
      priceTier, config,
    });
    expect((await root(u.id)).topupRemainingCents).toBe(1200);
  });

  it('a refund for a pack we never funded takes nothing', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const txn = { ...packTxn(u.token, 500), revocationDate: Date.now() };
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: txn, priceTier, config });
    expect(await ledgerFor(u.id)).toHaveLength(0);
  });
});

describe('who a transaction belongs to', () => {
  it("refuses a transaction carrying another user's account token and writes nothing", async () => {
    if (!dbAvailable) return;
    const buyer = await newUser();
    const replayer = await newUser();
    const txn = packTxn(buyer.token, 500);
    expect(await applyAppleTransaction({ source: 'device', userId: replayer.id, decoded: txn, priceTier, config })).toEqual({ result: 'refused', reason: 'account_mismatch' });
    expect(await ledgerFor(replayer.id)).toHaveLength(0);
    expect(await db.select().from(appStoreTransactions).where(eq(appStoreTransactions.transactionId, txn.transactionId!))).toHaveLength(0);
  });

  it('refuses to move a subscription another user already owns', async () => {
    if (!dbAvailable) return;
    const owner = await newUser();
    const other = await newUser();
    const original = nextTxnId();
    await applyAppleTransaction({ source: 'device', userId: owner.id, decoded: subscriptionTxn(owner.token, { originalTransactionId: original, transactionId: original }), priceTier, config });
    const renewalWithoutToken = subscriptionTxn(null, { originalTransactionId: original });
    expect(await applyAppleTransaction({ source: 'device', userId: other.id, decoded: renewalWithoutToken, priceTier, config })).toEqual({ result: 'refused', reason: 'owned_by_another_user' });
  });

  it('concurrent claims of one token-less subscription fund exactly one account', async () => {
    if (!dbAvailable) return;
    const buyers = await Promise.all([newUser(), newUser(), newUser(), newUser(), newUser()]);
    const original = nextTxnId();
    const claims = buyers.map(() => subscriptionTxn(null, { originalTransactionId: original }));
    const results = await Promise.all(buyers.map((b, i) => applyAppleTransaction({ source: 'device', userId: b.id, decoded: claims[i], priceTier, config })));
    expect(results.filter((r) => r.result === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.result === 'refused' && r.reason === 'owned_by_another_user')).toHaveLength(4);
    const grants = await db.select().from(creditLedger).where(and(inArray(creditLedger.userId, buyers.map((b) => b.id)), eq(creditLedger.entryType, 'monthly_grant')));
    expect(grants).toHaveLength(1);
    const [sub] = await db.select().from(appStoreSubscriptions).where(eq(appStoreSubscriptions.originalTransactionId, original));
    expect(grants[0].userId).toBe(sub.userId);
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
    // Still renewal-capable for the sweep, but Apple will not charge again: no deletion warning needed.
    expect(await hasRenewableAppleSubscription(db, u.id, new Date())).toBe(true);
    expect(await hasRenewableAppleSubscription(db, u.id, new Date(), { autoRenewing: true })).toBe(false);
  });

  it('refuses a notification whose buyer it cannot find', async () => {
    if (!dbAvailable) return;
    const original = nextTxnId();
    expect(await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'DID_RENEW', subtype: null, status: 1, transaction: subscriptionTxn(null, { originalTransactionId: original, transactionId: original }), renewal: null },
      priceTier, config,
    })).toEqual({ result: 'refused', reason: 'unknown_user' });
  });

  it('acknowledges a notification for a deleted account instead of asking Apple to retry it for days', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    const original = nextTxnId();
    const first = subscriptionTxn(u.token, { originalTransactionId: original, transactionId: original });
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: first, priceTier, config });
    // Account deletion: the mirror and the token go with the user; the transactions stay, anonymised.
    await db.delete(creditLedger).where(eq(creditLedger.userId, u.id));
    await db.delete(wallets).where(personalRootWalletOf(u.id));
    await db.delete(users).where(eq(users.id, u.id));

    const renewalId = nextTxnId();
    const renewal = subscriptionTxn(u.token, { originalTransactionId: original, transactionId: renewalId });
    expect(await applyAppleNotification({
      notification: { notificationUUID: createId(), type: 'DID_RENEW', subtype: null, status: 1, transaction: renewal, renewal: null },
      priceTier, config,
    })).toEqual({ result: 'ignored', reason: 'account_deleted' });
    expect(await db.select().from(appStoreTransactions).where(eq(appStoreTransactions.transactionId, renewalId))).toHaveLength(0);
  });

  it('refuses Sandbox money when the deployment does not allow it', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    expect(await applyAppleTransaction({ source: 'device', userId: u.id, decoded: packTxn(u.token, 100), priceTier, config: { ...config, allowSandbox: false } }))
      .toEqual({ result: 'refused', reason: 'sandbox_refused' });
  });

  it('does nothing where billing is off (tenant / onprem)', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    process.env.DEPLOYMENT_MODE = 'onprem';
    expect(await applyAppleTransaction({ source: 'device', userId: u.id, decoded: packTxn(u.token, 100), priceTier, config })).toEqual({ result: 'refused', reason: 'not_billing' });
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

  it('an unpaid Stripe subscription still counts as a contract that can renew; a canceled one does not', async () => {
    if (!dbAvailable) return;
    const unpaid = await newUser();
    const canceled = await newUser();
    await stripePro(unpaid.id, 'unpaid');
    await stripePro(canceled.id, 'canceled');
    expect(await hasRenewableStripeSubscription(db, unpaid.id)).toBe(true);
    expect(await hasRenewableStripeSubscription(db, canceled.id)).toBe(false);
  });

  it('an expired App Store plan does not demote an active Stripe Pro', async () => {
    if (!dbAvailable) return;
    const u = await newUser();
    await stripePro(u.id);
    const original = nextTxnId();
    const now = Date.now();
    await applyAppleTransaction({
      source: 'device',
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
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: subscriptionTxn(u.token, { originalTransactionId: original, transactionId: original }), priceTier, config });
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
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: subscriptionTxn(u.token, { originalTransactionId: original, transactionId: original }), priceTier, config });
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
    await applyAppleTransaction({ source: 'device', userId: u.id, decoded: subscriptionTxn(u.token, { originalTransactionId: original, transactionId: original }), priceTier, config });
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
