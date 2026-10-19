import { describe, it, expect } from 'vitest';
import { APPLE_PRODUCTS, APPLE_PRO_MONTHLY } from '@pagespace/lib/billing/apple/apple-products';
import {
  appleCreditPacks,
  applePlanAction,
  appleProProduct,
  classifyTransactionResponse,
  finishDecision,
  formatAppleProductPrice,
  formatSubscriptionPeriod,
  mergeAppleProducts,
  purchaseResultFromSync,
  purchaseResultMessage,
  type StoreKitProduct,
} from '../apple-store-core';

const skProduct = (id: string, extra: Partial<StoreKitProduct> = {}): StoreKitProduct => ({
  id,
  displayName: `name ${id}`,
  description: `desc ${id}`,
  displayPrice: '€1,00',
  price: '1.00',
  currencyCode: 'EUR',
  type: 'consumable',
  ...extra,
});

describe('finishDecision', () => {
  it.each([200, 201, 204, 299])('given %i (applied or duplicate), should finish', (status) => {
    expect(finishDecision(status)).toBe('finish');
  });

  it('given 400 (a JWS that will never verify), should finish', () => {
    expect(finishDecision(400)).toBe('finish');
  });

  it('given 422 (permanent refusal), should finish', () => {
    expect(finishDecision(422)).toBe('finish');
  });

  it.each([0, 401, 403, 404, 409, 429, 500, 502, 503])('given %i (auth, server or network trouble), should keep it for a retry', (status) => {
    expect(finishDecision(status)).toBe('retry');
  });
});

describe('mergeAppleProducts', () => {
  it('given StoreKit returned every product, should keep catalog order and take the localized display fields', () => {
    const storeKit = [...APPLE_PRODUCTS].reverse().map((p) =>
      skProduct(p.productId, { displayPrice: `¥${p.productId.length}` }),
    );
    const merged = mergeAppleProducts(APPLE_PRODUCTS, storeKit);
    expect(merged.map((p) => p.productId)).toEqual(APPLE_PRODUCTS.map((p) => p.productId));
    expect(merged[0].displayPrice).toBe(`¥${APPLE_PRODUCTS[0].productId.length}`);
    expect(merged[0].kind).toBe(APPLE_PRODUCTS[0].kind);
  });

  it('given StoreKit did not return a catalog product, should drop it', () => {
    const merged = mergeAppleProducts(APPLE_PRODUCTS, [skProduct(APPLE_PRO_MONTHLY.productId)]);
    expect(merged.map((p) => p.productId)).toEqual([APPLE_PRO_MONTHLY.productId]);
  });

  it('given StoreKit returned a product the catalog does not sell, should ignore it', () => {
    expect(mergeAppleProducts(APPLE_PRODUCTS, [skProduct('com.example.other')])).toEqual([]);
  });

  it('should carry the subscription period through for subscriptions', () => {
    const [pro] = mergeAppleProducts(APPLE_PRODUCTS, [
      skProduct(APPLE_PRO_MONTHLY.productId, { type: 'autoRenewable', subscriptionPeriod: { unit: 'month', value: 1 } }),
    ]);
    expect(pro.subscriptionPeriod).toEqual({ unit: 'month', value: 1 });
  });
});

describe('formatSubscriptionPeriod / formatAppleProductPrice', () => {
  it('given a one-unit period, should read "/month"', () => {
    expect(formatSubscriptionPeriod({ unit: 'month', value: 1 })).toBe('/month');
  });

  it('given a multi-unit period, should pluralize', () => {
    expect(formatSubscriptionPeriod({ unit: 'month', value: 3 })).toBe('/3 months');
  });

  it('given no period (a consumable) or a nonsense one, should add nothing', () => {
    expect(formatSubscriptionPeriod(undefined)).toBe('');
    expect(formatSubscriptionPeriod({ unit: 'month', value: 0 })).toBe('');
  });

  it('should show StoreKit\'s localized price verbatim', () => {
    expect(formatAppleProductPrice({ displayPrice: '19,99 €', subscriptionPeriod: { unit: 'month', value: 1 } })).toBe('19,99 €/month');
    expect(formatAppleProductPrice({ displayPrice: '£9.99' })).toBe('£9.99');
  });
});

describe('classifyTransactionResponse', () => {
  const applied = { result: 'applied', kind: 'subscription', subscriptionTier: 'pro' } as const;

  it('given 2xx, should be applied with the server body', () => {
    expect(classifyTransactionResponse(200, applied)).toEqual({ status: 'applied', data: applied });
  });

  it('given 422, should be refused with the reason', () => {
    expect(classifyTransactionResponse(422, { error: 'refused', reason: 'other_account' })).toEqual({ status: 'refused', reason: 'other_account' });
    expect(classifyTransactionResponse(422, undefined)).toEqual({ status: 'refused', reason: null });
  });

  it('given 400, should be invalid', () => {
    expect(classifyTransactionResponse(400, { error: 'bad' })).toEqual({ status: 'invalid' });
  });

  it('given anything else, should be a retry carrying the status', () => {
    expect(classifyTransactionResponse(503, undefined)).toEqual({ status: 'retry', httpStatus: 503 });
    expect(classifyTransactionResponse(0, undefined)).toEqual({ status: 'retry', httpStatus: 0 });
  });
});

describe('purchaseResultFromSync / purchaseResultMessage', () => {
  it('given the server applied it, should report success with the server tier', () => {
    const result = purchaseResultFromSync({ status: 'applied', data: { result: 'duplicate', kind: 'subscription', subscriptionTier: 'pro' } });
    expect(result).toEqual({ status: 'success', subscriptionTier: 'pro', kind: 'subscription' });
    expect(purchaseResultMessage(result)?.tone).toBe('success');
  });

  it('given a refusal because the purchase is another account\'s, should say so', () => {
    for (const reason of ['account_mismatch', 'owned_by_another_user']) {
      const result = purchaseResultFromSync({ status: 'refused', reason });
      expect(result).toEqual({ status: 'refused', reason });
      expect(purchaseResultMessage(result)?.text).toMatch(/different PageSpace account/);
    }
  });

  it('given any other refusal, should not blame another account', () => {
    const result = purchaseResultFromSync({ status: 'refused', reason: 'sandbox_refused' });
    expect(purchaseResultMessage(result)).toEqual({ tone: 'error', text: expect.stringMatching(/couldn't be applied/) });
  });

  it('given the server could not be reached, should report an error that does not claim success', () => {
    const result = purchaseResultFromSync({ status: 'retry', httpStatus: 503 });
    expect(result.status).toBe('error');
    expect(purchaseResultMessage(result)?.tone).toBe('error');
  });

  it('given a cancellation, should say nothing', () => {
    expect(purchaseResultMessage({ status: 'cancelled' })).toBeNull();
  });

  it('given a consumable, should say credits were added', () => {
    expect(purchaseResultMessage({ status: 'success', subscriptionTier: 'free', kind: 'consumable' })?.text).toMatch(/credits/i);
  });
});

describe('applePlanAction', () => {
  it('given a free user with no store, should offer Subscribe', () => {
    expect(applePlanAction({ subscriptionTier: 'free', billingProvider: null })).toBe('subscribe');
    expect(applePlanAction({ subscriptionTier: 'free', billingProvider: undefined })).toBe('subscribe');
  });

  it('given an App Store subscriber, should offer Manage Subscription', () => {
    expect(applePlanAction({ subscriptionTier: 'pro', billingProvider: 'apple' })).toBe('manage');
  });

  it('given a Stripe subscriber on iOS, should say it is managed on the web (no CTA)', () => {
    expect(applePlanAction({ subscriptionTier: 'pro', billingProvider: 'stripe' })).toBe('managed-on-web');
  });

  it('given an organization plan, should defer to the org admin', () => {
    expect(applePlanAction({ subscriptionTier: 'business', billingProvider: null })).toBe('managed-by-org');
  });

  it('given a paid tier from neither store, should not sell it again', () => {
    expect(applePlanAction({ subscriptionTier: 'pro', billingProvider: null })).toBe('included');
  });
});

describe('product partitions', () => {
  it('should find Pro and the credit packs', () => {
    const merged = mergeAppleProducts(APPLE_PRODUCTS, APPLE_PRODUCTS.map((p) => skProduct(p.productId)));
    expect(appleProProduct(merged)?.productId).toBe(APPLE_PRO_MONTHLY.productId);
    expect(appleCreditPacks(merged).map((p) => p.productId)).toEqual([
      'ai.pagespace.ios.credits.100',
      'ai.pagespace.ios.credits.250',
      'ai.pagespace.ios.credits.500',
    ]);
    expect(appleProProduct([])).toBeUndefined();
  });
});
