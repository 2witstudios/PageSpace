import { describe, it, expect } from 'vitest';
import {
  allocateClawback,
  appleRowEntitles,
  appleSubscriptionStatus,
  classifyAppleNotification,
  combineTiers,
  deriveTierFromAppleSubscriptions,
  entitlementEndMs,
  planAppleTransaction,
  reconcileRevocation,
  toTransactionFacts,
  type AppleTransactionFacts,
  type PlanContext,
} from '../apple-core';
import { allowanceCentsForPaidCents, tierListPriceCents } from '../../money-model';

const BUNDLE = 'ai.pagespace.ios';
const TOKEN = '6f1c0b9e-3c43-4b8f-9d7f-0b1a2c3d4e5f';
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 19, 12);

function facts(overrides: Partial<AppleTransactionFacts> = {}): AppleTransactionFacts {
  return {
    transactionId: '2000000123456789',
    originalTransactionId: '2000000123456700',
    productId: 'ai.pagespace.ios.pro.monthly',
    bundleId: BUNDLE,
    environment: 'Production',
    purchaseDateMs: NOW - DAY,
    expiresDateMs: NOW + 29 * DAY,
    revocationDateMs: null,
    appAccountToken: TOKEN,
    priceMilliunits: 17_990,
    currency: 'USD',
    storefront: 'USA',
    familyShared: false,
    ...overrides,
  };
}

const ctx = (overrides: Partial<PlanContext> = {}): PlanContext => ({
  bundleId: BUNDLE,
  allowSandbox: false,
  expectedAccountToken: TOKEN,
  ownershipEstablished: false,
  ...overrides,
});

describe('toTransactionFacts', () => {
  const decoded = {
    transactionId: '2000000123456789',
    originalTransactionId: '2000000123456700',
    productId: 'ai.pagespace.ios.pro.monthly',
    bundleId: BUNDLE,
    environment: 'Sandbox',
    purchaseDate: NOW - DAY,
    expiresDate: NOW + 29 * DAY,
    appAccountToken: TOKEN.toUpperCase(),
    price: 17_990,
    currency: 'USD',
    storefront: 'USA',
    inAppOwnershipType: 'PURCHASED',
  };

  it('normalizes a decoded StoreKit transaction into the facts the planner reads', () => {
    expect(toTransactionFacts(decoded)).toEqual({
      transactionId: '2000000123456789',
      originalTransactionId: '2000000123456700',
      productId: 'ai.pagespace.ios.pro.monthly',
      bundleId: BUNDLE,
      environment: 'Sandbox',
      purchaseDateMs: NOW - DAY,
      expiresDateMs: NOW + 29 * DAY,
      revocationDateMs: null,
      appAccountToken: TOKEN,
      priceMilliunits: 17_990,
      currency: 'USD',
      storefront: 'USA',
      familyShared: false,
    });
  });

  it('marks a family-shared transaction', () => {
    expect(toTransactionFacts({ ...decoded, inAppOwnershipType: 'FAMILY_SHARED' })?.familyShared).toBe(true);
  });

  it('carries the revocation instant of a refunded transaction', () => {
    expect(toTransactionFacts({ ...decoded, revocationDate: NOW })?.revocationDateMs).toBe(NOW);
  });

  it('rejects a payload missing any identity field', () => {
    for (const field of ['transactionId', 'originalTransactionId', 'productId', 'bundleId', 'purchaseDate'] as const) {
      expect(toTransactionFacts({ ...decoded, [field]: undefined })).toBeNull();
    }
  });

  it('rejects an environment the App Store does not sign for real money or review (Xcode, LocalTesting)', () => {
    expect(toTransactionFacts({ ...decoded, environment: 'Xcode' })).toBeNull();
    expect(toTransactionFacts({ ...decoded, environment: 'LocalTesting' })).toBeNull();
    expect(toTransactionFacts({ ...decoded, environment: undefined })).toBeNull();
  });

  it('reads an absent token, price or expiry as null rather than inventing one', () => {
    const f = toTransactionFacts({ ...decoded, appAccountToken: undefined, price: undefined, expiresDate: undefined });
    expect(f).toMatchObject({ appAccountToken: null, priceMilliunits: null, expiresDateMs: null });
  });
});

describe('planAppleTransaction — refusals', () => {
  it('refuses a transaction signed for another app', () => {
    expect(planAppleTransaction(facts({ bundleId: 'com.evil.app' }), ctx())).toEqual({ kind: 'refuse', reason: 'wrong_bundle' });
  });

  it('refuses Sandbox money unless the deployment allows it (App Review buys in Sandbox against production)', () => {
    expect(planAppleTransaction(facts({ environment: 'Sandbox' }), ctx())).toEqual({ kind: 'refuse', reason: 'sandbox_refused' });
    expect(planAppleTransaction(facts({ environment: 'Sandbox' }), ctx({ allowSandbox: true })).kind).toBe('subscription_period');
  });

  it('refuses a family-shared purchase: the buyer, not the family, holds the plan', () => {
    expect(planAppleTransaction(facts({ familyShared: true }), ctx())).toEqual({ kind: 'refuse', reason: 'family_shared' });
  });

  it("refuses a transaction carrying someone else's account token (a replayed receipt)", () => {
    expect(planAppleTransaction(facts({ appAccountToken: '00000000-0000-4000-8000-000000000000' }), ctx())).toEqual({ kind: 'refuse', reason: 'account_mismatch' });
  });

  it('refuses a tokened transaction when the caller has no token yet', () => {
    expect(planAppleTransaction(facts(), ctx({ expectedAccountToken: null }))).toEqual({ kind: 'refuse', reason: 'account_mismatch' });
  });

  it('refuses a token-less transaction unless this user already owns the subscription', () => {
    expect(planAppleTransaction(facts({ appAccountToken: null }), ctx())).toEqual({ kind: 'refuse', reason: 'account_mismatch' });
    expect(planAppleTransaction(facts({ appAccountToken: null }), ctx({ ownershipEstablished: true })).kind).toBe('subscription_period');
  });

  it('refuses a product we do not sell', () => {
    expect(planAppleTransaction(facts({ productId: 'ai.pagespace.ios.business.monthly' }), ctx())).toEqual({ kind: 'refuse', reason: 'unknown_product' });
  });

  it('refuses a subscription transaction without an expiry', () => {
    expect(planAppleTransaction(facts({ expiresDateMs: null }), ctx())).toEqual({ kind: 'refuse', reason: 'malformed' });
  });

  it('checks the bundle before anything that depends on the buyer', () => {
    expect(planAppleTransaction(facts({ bundleId: 'x', appAccountToken: 'other' }), ctx())).toEqual({ kind: 'refuse', reason: 'wrong_bundle' });
  });
});

describe('planAppleTransaction — subscriptions', () => {
  it('grants a Pro period sized from the WEB price, so iOS Pro includes exactly what web Pro does', () => {
    const plan = planAppleTransaction(facts(), ctx());
    expect(plan).toEqual({
      kind: 'subscription_period',
      productId: 'ai.pagespace.ios.pro.monthly',
      tier: 'pro',
      paidCents: tierListPriceCents('pro'),
      allowanceCents: allowanceCentsForPaidCents(tierListPriceCents('pro'), 'pro'),
      periodStartMs: NOW - DAY,
      periodEndMs: NOW + 29 * DAY,
    });
    expect(plan.kind === 'subscription_period' && plan.allowanceCents).toBe(900);
  });

  it('does not let the Apple price inflate the grant', () => {
    const cheap = planAppleTransaction(facts({ priceMilliunits: 17_990 }), ctx());
    const pricey = planAppleTransaction(facts({ priceMilliunits: 99_990 }), ctx());
    expect(cheap).toEqual(pricey);
  });

  it('grants nothing for a period Apple charged nothing for (a free trial or offer), as a $0 Stripe invoice', () => {
    expect(planAppleTransaction(facts({ priceMilliunits: 0 }), ctx())).toMatchObject({ kind: 'subscription_period', allowanceCents: 0, paidCents: 0 });
  });

  it('plans a revoke for a refunded subscription transaction, clawing back what that period granted', () => {
    expect(planAppleTransaction(facts({ revocationDateMs: NOW }), ctx())).toEqual({
      kind: 'revoke_subscription',
      productId: 'ai.pagespace.ios.pro.monthly',
      clawbackCents: 900,
    });
  });
});

describe('planAppleTransaction — consumables', () => {
  it('adds the pack to the top-up bucket at its web credit value', () => {
    expect(planAppleTransaction(facts({ productId: 'ai.pagespace.ios.credits.250', expiresDateMs: null }), ctx())).toEqual({
      kind: 'consumable',
      productId: 'ai.pagespace.ios.credits.250',
      topupCents: 2500,
    });
  });

  it('plans a clawback of the whole pack when it is refunded', () => {
    expect(planAppleTransaction(facts({ productId: 'ai.pagespace.ios.credits.100', expiresDateMs: null, revocationDateMs: NOW }), ctx())).toEqual({
      kind: 'revoke_consumable',
      productId: 'ai.pagespace.ios.credits.100',
      clawbackCents: 1000,
    });
  });
});

describe('appleSubscriptionStatus', () => {
  it('is revoked once Apple revoked the transaction, whatever else it says', () => {
    expect(appleSubscriptionStatus({ facts: facts({ revocationDateMs: NOW }), notificationStatus: 1, nowMs: NOW })).toBe('revoked');
  });

  it("follows the notification's status when one was sent", () => {
    expect(appleSubscriptionStatus({ facts: facts(), notificationStatus: 1, nowMs: NOW })).toBe('active');
    expect(appleSubscriptionStatus({ facts: facts(), notificationStatus: 2, nowMs: NOW })).toBe('expired');
    expect(appleSubscriptionStatus({ facts: facts(), notificationStatus: 3, nowMs: NOW })).toBe('billing_retry');
    expect(appleSubscriptionStatus({ facts: facts(), notificationStatus: 4, nowMs: NOW })).toBe('grace_period');
    expect(appleSubscriptionStatus({ facts: facts(), notificationStatus: 5, nowMs: NOW })).toBe('revoked');
  });

  it('falls back to the expiry when no status was sent (a device sync)', () => {
    expect(appleSubscriptionStatus({ facts: facts(), notificationStatus: null, nowMs: NOW })).toBe('active');
    expect(appleSubscriptionStatus({ facts: facts({ expiresDateMs: NOW - 1 }), notificationStatus: null, nowMs: NOW })).toBe('expired');
    expect(appleSubscriptionStatus({ facts: facts(), notificationStatus: 99, nowMs: NOW })).toBe('active');
  });
});

describe('entitlementEndMs', () => {
  it('is the paid period end, extended to the grace period end while billing is in grace', () => {
    expect(entitlementEndMs({ expiresDateMs: NOW, gracePeriodExpiresMs: NOW + 6 * DAY, status: 'grace_period' })).toBe(NOW + 6 * DAY);
    expect(entitlementEndMs({ expiresDateMs: NOW, gracePeriodExpiresMs: NOW + 6 * DAY, status: 'active' })).toBe(NOW);
    expect(entitlementEndMs({ expiresDateMs: NOW, gracePeriodExpiresMs: null, status: 'grace_period' })).toBe(NOW);
  });
});

describe('appleRowEntitles / deriveTierFromAppleSubscriptions', () => {
  const row = (status: string, expiresAtMs: number, productId = 'ai.pagespace.ios.pro.monthly') => ({ status, expiresAtMs, productId });

  it('entitles only an active or in-grace subscription whose period has not ended', () => {
    expect(appleRowEntitles(row('active', NOW + 1), NOW)).toBe(true);
    expect(appleRowEntitles(row('grace_period', NOW + 1), NOW)).toBe(true);
    expect(appleRowEntitles(row('active', NOW), NOW)).toBe(false);
    for (const status of ['billing_retry', 'expired', 'revoked', 'weird']) {
      expect(appleRowEntitles(row(status, NOW + DAY), NOW)).toBe(false);
    }
  });

  it('derives Pro from an entitled Pro row and Free otherwise', () => {
    expect(deriveTierFromAppleSubscriptions([row('active', NOW + DAY)], NOW)).toBe('pro');
    expect(deriveTierFromAppleSubscriptions([row('active', NOW - DAY)], NOW)).toBe('free');
    expect(deriveTierFromAppleSubscriptions([], NOW)).toBe('free');
  });

  it('never grants a tier for an unknown or consumable product id', () => {
    expect(deriveTierFromAppleSubscriptions([row('active', NOW + DAY, 'ai.pagespace.ios.credits.100')], NOW)).toBe('free');
    expect(deriveTierFromAppleSubscriptions([row('active', NOW + DAY, 'legacy.founder')], NOW)).toBe('free');
  });
});

describe('combineTiers', () => {
  it('is the highest tier any store entitles', () => {
    expect(combineTiers('free', 'pro')).toBe('pro');
    expect(combineTiers('pro', 'free')).toBe('pro');
    expect(combineTiers('free', 'free')).toBe('free');
    expect(combineTiers('business', 'pro')).toBe('business');
    expect(combineTiers()).toBe('free');
  });
});

describe('allocateClawback', () => {
  it('takes a refunded pack from the top-up bucket first, then monthly, and owes the rest as debt', () => {
    expect(allocateClawback({ monthlyCents: 300, topupCents: 500 }, 1000, 'topup')).toEqual({ monthlyCents: 0, topupCents: 0, appliedCents: 800, debtCents: 200 });
    expect(allocateClawback({ monthlyCents: 300, topupCents: 1500 }, 1000, 'topup')).toEqual({ monthlyCents: 300, topupCents: 500, appliedCents: 1000, debtCents: 0 });
  });

  it('takes a refunded subscription period from the monthly bucket first', () => {
    expect(allocateClawback({ monthlyCents: 600, topupCents: 500 }, 900, 'monthly')).toEqual({ monthlyCents: 0, topupCents: 200, appliedCents: 900, debtCents: 0 });
  });

  it('claws back nothing for a non-positive amount', () => {
    expect(allocateClawback({ monthlyCents: 5, topupCents: 5 }, 0, 'monthly')).toEqual({ monthlyCents: 5, topupCents: 5, appliedCents: 0, debtCents: 0 });
    expect(allocateClawback({ monthlyCents: 5, topupCents: 5 }, -10, 'topup')).toEqual({ monthlyCents: 5, topupCents: 5, appliedCents: 0, debtCents: 0 });
  });
});

describe('reconcileRevocation', () => {
  it('revokes once, reinstates a reversed refund once, and otherwise does nothing', () => {
    expect(reconcileRevocation({ storedRevoked: false, factsRevoked: true })).toBe('revoke');
    expect(reconcileRevocation({ storedRevoked: true, factsRevoked: false })).toBe('reinstate');
    expect(reconcileRevocation({ storedRevoked: true, factsRevoked: true })).toBe('none');
    expect(reconcileRevocation({ storedRevoked: false, factsRevoked: false })).toBe('none');
  });
});

describe('classifyAppleNotification', () => {
  it('acks a TEST notification without touching money', () => {
    expect(classifyAppleNotification('TEST')).toBe('test');
  });

  it('applies the signed transaction of every notification that changes a purchase', () => {
    for (const type of ['SUBSCRIBED', 'DID_RENEW', 'DID_CHANGE_RENEWAL_STATUS', 'DID_CHANGE_RENEWAL_PREF', 'DID_FAIL_TO_RENEW', 'GRACE_PERIOD_EXPIRED', 'EXPIRED', 'REFUND', 'REVOKE', 'REFUND_REVERSED', 'ONE_TIME_CHARGE', 'RENEWAL_EXTENDED', 'OFFER_REDEEMED']) {
      expect(classifyAppleNotification(type)).toBe('transaction');
    }
  });

  it('ignores notifications that change nothing we mirror', () => {
    for (const type of ['CONSUMPTION_REQUEST', 'REFUND_DECLINED', 'PRICE_INCREASE', 'RENEWAL_EXTENSION', 'EXTERNAL_PURCHASE_TOKEN', 'SOMETHING_NEW', undefined]) {
      expect(classifyAppleNotification(type)).toBe('ignore');
    }
  });
});
