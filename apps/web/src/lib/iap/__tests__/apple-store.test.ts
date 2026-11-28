import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  class ApiRequestError extends Error {
    readonly status: number;
    readonly body: unknown;
    constructor(message: string, status: number, body?: unknown) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }
  return {
    ApiRequestError,
    post: vi.fn(),
    mutate: vi.fn(),
    plugin: {
      getProducts: vi.fn(),
      purchase: vi.fn(),
      finish: vi.fn(),
      unfinished: vi.fn(),
      restore: vi.fn(),
      manageSubscriptions: vi.fn(),
      addListener: vi.fn(),
    },
  };
});

vi.mock('@capacitor/core', () => ({ registerPlugin: () => mocks.plugin }));
vi.mock('swr', () => ({ mutate: mocks.mutate }));
vi.mock('@/lib/auth/auth-fetch', () => ({ post: mocks.post, ApiRequestError: mocks.ApiRequestError }));

import {
  drainUnfinished,
  loadAppleProducts,
  purchaseAppleProduct,
  restoreApplePurchases,
  startAppleTransactionObserver,
  syncAppleTransaction,
} from '../apple-store';
import { APPLE_PRO_MONTHLY } from '@pagespace/lib/billing/apple/apple-products';

const APPLIED = { result: 'applied', kind: 'subscription', subscriptionTier: 'pro' };

/** Route post() by URL: the account token, then the transaction answer. */
function server({ transaction }: { transaction: () => Promise<unknown> }) {
  mocks.post.mockImplementation((url: string) => {
    if (url === '/api/iap/apple/account-token') return Promise.resolve({ accountToken: 'token-uuid' });
    if (url === '/api/iap/apple/transactions') return transaction();
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

describe('apple-store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.plugin.finish.mockResolvedValue({});
    mocks.mutate.mockResolvedValue(undefined);
  });

  describe('loadAppleProducts', () => {
    it('asks StoreKit for every catalog id and keeps only what it returned', async () => {
      mocks.plugin.getProducts.mockResolvedValue({
        products: [{ id: APPLE_PRO_MONTHLY.productId, displayName: 'Pro', description: '', displayPrice: '$17.99', price: '17.99', currencyCode: 'USD', type: 'autoRenewable', subscriptionPeriod: { unit: 'month', value: 1 } }],
      });
      const products = await loadAppleProducts();
      expect(mocks.plugin.getProducts).toHaveBeenCalledWith({ productIds: expect.arrayContaining([APPLE_PRO_MONTHLY.productId, 'ai.pagespace.ios.credits.100']) });
      expect(products).toHaveLength(1);
      expect(products[0]).toMatchObject({ productId: APPLE_PRO_MONTHLY.productId, displayPrice: '$17.99', kind: 'subscription' });
    });
  });

  describe('purchaseAppleProduct', () => {
    it('passes the server account token to StoreKit, posts the JWS, finishes, refreshes caches and reports the server tier', async () => {
      server({ transaction: () => Promise.resolve(APPLIED) });
      mocks.plugin.purchase.mockResolvedValue({ status: 'success', jws: 'jws-1', transactionId: 't1' });

      const result = await purchaseAppleProduct(APPLE_PRO_MONTHLY.productId);

      expect(mocks.plugin.purchase).toHaveBeenCalledWith({ productId: APPLE_PRO_MONTHLY.productId, appAccountToken: 'token-uuid' });
      expect(mocks.post).toHaveBeenCalledWith('/api/iap/apple/transactions', { signedTransaction: 'jws-1' });
      expect(mocks.plugin.finish).toHaveBeenCalledWith({ transactionId: 't1' });
      expect(mocks.mutate).toHaveBeenCalledWith('/api/subscriptions/status');
      expect(mocks.mutate).toHaveBeenCalledWith('/api/credits');
      expect(result).toEqual({ status: 'success', subscriptionTier: 'pro', kind: 'subscription' });
    });

    it('does not finish and does not report success when the server is unavailable', async () => {
      server({ transaction: () => Promise.reject(new mocks.ApiRequestError('down', 503)) });
      mocks.plugin.purchase.mockResolvedValue({ status: 'success', jws: 'jws-1', transactionId: 't1' });

      const result = await purchaseAppleProduct(APPLE_PRO_MONTHLY.productId);

      expect(mocks.plugin.finish).not.toHaveBeenCalled();
      expect(result.status).toBe('error');
    });

    it('does not finish on a network failure', async () => {
      server({ transaction: () => Promise.reject(new TypeError('Failed to fetch')) });
      mocks.plugin.purchase.mockResolvedValue({ status: 'success', jws: 'jws-1', transactionId: 't1' });

      await purchaseAppleProduct(APPLE_PRO_MONTHLY.productId);

      expect(mocks.plugin.finish).not.toHaveBeenCalled();
    });

    it('finishes and reports refused on a 422', async () => {
      server({ transaction: () => Promise.reject(new mocks.ApiRequestError('refused', 422, { error: 'refused', reason: 'other_account' })) });
      mocks.plugin.purchase.mockResolvedValue({ status: 'success', jws: 'jws-1', transactionId: 't1' });

      const result = await purchaseAppleProduct(APPLE_PRO_MONTHLY.productId);

      expect(mocks.plugin.finish).toHaveBeenCalledWith({ transactionId: 't1' });
      expect(result).toEqual({ status: 'refused', reason: 'other_account' });
    });

    it('passes cancelled and pending through without touching the server', async () => {
      server({ transaction: () => Promise.resolve(APPLIED) });
      mocks.plugin.purchase.mockResolvedValueOnce({ status: 'cancelled' }).mockResolvedValueOnce({ status: 'pending' });

      expect(await purchaseAppleProduct(APPLE_PRO_MONTHLY.productId)).toEqual({ status: 'cancelled' });
      expect(await purchaseAppleProduct(APPLE_PRO_MONTHLY.productId)).toEqual({ status: 'pending' });
      expect(mocks.post).not.toHaveBeenCalledWith('/api/iap/apple/transactions', expect.anything());
    });

    it('reports an error (never rejects) when StoreKit throws or the token cannot be fetched', async () => {
      server({ transaction: () => Promise.resolve(APPLIED) });
      mocks.plugin.purchase.mockRejectedValue(new Error('unverified'));
      expect(await purchaseAppleProduct(APPLE_PRO_MONTHLY.productId)).toEqual({ status: 'error', message: 'unverified' });

      mocks.post.mockRejectedValue(new mocks.ApiRequestError('Unauthorized', 401));
      const result = await purchaseAppleProduct(APPLE_PRO_MONTHLY.productId);
      expect(result.status).toBe('error');
    });
  });

  describe('syncAppleTransaction', () => {
    it('shares one round-trip between concurrent syncs of the same transaction', async () => {
      let resolve: (value: unknown) => void = () => undefined;
      server({ transaction: () => new Promise((r) => { resolve = r; }) });

      const a = syncAppleTransaction('jws', 't1');
      const b = syncAppleTransaction('jws', 't1');
      resolve(APPLIED);
      await Promise.all([a, b]);

      expect(mocks.post).toHaveBeenCalledTimes(1);
      expect(mocks.plugin.finish).toHaveBeenCalledTimes(1);
    });

    it('finishes an unverifiable (400) transaction', async () => {
      server({ transaction: () => Promise.reject(new mocks.ApiRequestError('bad', 400)) });
      expect(await syncAppleTransaction('jws', 't2')).toEqual({ status: 'invalid' });
      expect(mocks.plugin.finish).toHaveBeenCalledWith({ transactionId: 't2' });
    });
  });

  describe('drainUnfinished / restoreApplePurchases', () => {
    it('drains each unfinished transaction, finishing per status', async () => {
      mocks.plugin.unfinished.mockResolvedValue({ transactions: [{ jws: 'a', transactionId: 'ta' }, { jws: 'b', transactionId: 'tb' }] });
      mocks.post.mockImplementation((_url: string, body: { signedTransaction: string }) =>
        body.signedTransaction === 'a' ? Promise.resolve(APPLIED) : Promise.reject(new mocks.ApiRequestError('x', 401)),
      );

      const summary = await drainUnfinished();

      expect(summary).toEqual({ applied: 1, refused: 0, failed: 1 });
      expect(mocks.plugin.finish).toHaveBeenCalledWith({ transactionId: 'ta' });
      expect(mocks.plugin.finish).not.toHaveBeenCalledWith({ transactionId: 'tb' });
      expect(mocks.mutate).toHaveBeenCalled();
    });

    it('restores by syncing every entitlement the App Store returns', async () => {
      mocks.plugin.restore.mockResolvedValue({ transactions: [{ jws: 'a', transactionId: 'ta' }] });
      server({ transaction: () => Promise.resolve(APPLIED) });

      expect(await restoreApplePurchases()).toEqual({ applied: 1, refused: 0, failed: 0 });
    });
  });

  describe('startAppleTransactionObserver', () => {
    it('attaches the listener once across mounts, drains, syncs updates, and detaches after the last stop', async () => {
      const remove = vi.fn().mockResolvedValue(undefined);
      let listener: ((t: { jws: string; transactionId: string }) => void) | undefined;
      mocks.plugin.addListener.mockImplementation((_event: string, cb: typeof listener) => {
        listener = cb;
        return Promise.resolve({ remove });
      });
      mocks.plugin.unfinished.mockResolvedValue({ transactions: [] });
      server({ transaction: () => Promise.resolve(APPLIED) });

      const stopA = startAppleTransactionObserver();
      const stopB = startAppleTransactionObserver();
      expect(mocks.plugin.addListener).toHaveBeenCalledTimes(1);
      expect(mocks.plugin.addListener).toHaveBeenCalledWith('transactionUpdated', expect.any(Function));
      expect(mocks.plugin.unfinished).toHaveBeenCalled();

      listener?.({ jws: 'renewal', transactionId: 'tr' });
      await vi.waitFor(() => expect(mocks.plugin.finish).toHaveBeenCalledWith({ transactionId: 'tr' }));
      expect(mocks.mutate).toHaveBeenCalledWith('/api/credits');

      stopA();
      expect(remove).not.toHaveBeenCalled();
      stopB();
      await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    });
  });
});
