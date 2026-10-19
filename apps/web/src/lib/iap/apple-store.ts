/**
 * Apple In-App Purchase — the effectful client. Talks to the native StoreKit 2
 * plugin (`PageSpaceStore`) over the Capacitor bridge and to the server's
 * `/api/iap/apple/*` routes.
 *
 * Only call this on the `'apple'` billing channel (useBillingVisibility): that
 * is iOS AND a binary that registered the plugin. Import it lazily from UI so
 * web bundles that never sell through Apple do not pay for it.
 *
 * Rules (shared IAP contract):
 * - a purchase is reported successful only after the server confirms (2xx);
 * - a transaction is finished per `finishDecision` — never on 401/403/5xx or a
 *   network failure, so StoreKit redelivers it and we retry later.
 */

import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { mutate } from 'swr';
import { APPLE_PRODUCTS, appleProductIds } from '@pagespace/lib/billing/apple/apple-products';
import { post, ApiRequestError } from '@/lib/auth/auth-fetch';
import {
  APPLE_BILLING_CHANGED_EVENT,
  PAGESPACE_STORE_PLUGIN,
  classifyTransactionResponse,
  finishDecision,
  mergeAppleProducts,
  purchaseResultFromSync,
  type AppleStoreProduct,
  type AppleSyncResult,
  type ApplePurchaseResult,
  type StoreKitProduct,
  type StoreKitPurchaseResult,
  type StoreKitTransaction,
} from './apple-store-core';

export interface PageSpaceStorePlugin {
  getProducts(options: { productIds: string[] }): Promise<{ products: StoreKitProduct[] }>;
  purchase(options: { productId: string; appAccountToken: string }): Promise<StoreKitPurchaseResult>;
  finish(options: { transactionId: string }): Promise<Record<string, never>>;
  currentEntitlements(): Promise<{ transactions: StoreKitTransaction[] }>;
  unfinished(): Promise<{ transactions: StoreKitTransaction[] }>;
  restore(): Promise<{ transactions: StoreKitTransaction[] }>;
  manageSubscriptions(): Promise<Record<string, never>>;
  addListener(
    eventName: 'transactionUpdated',
    listener: (transaction: StoreKitTransaction) => void,
  ): Promise<PluginListenerHandle>;
}

export const PageSpaceStore = registerPlugin<PageSpaceStorePlugin>(PAGESPACE_STORE_PLUGIN);

/** SWR keys whose data a confirmed App Store transaction changes. */
export const APPLE_BILLING_SWR_KEYS = ['/api/subscriptions/status', '/api/credits'] as const;

/** Revalidate the subscription status and credit balance caches, and announce the change. Never rejects. */
export async function revalidateBillingCaches(): Promise<void> {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(APPLE_BILLING_CHANGED_EVENT));
  try {
    await Promise.all(APPLE_BILLING_SWR_KEYS.map((key) => mutate(key)));
  } catch (err) {
    // Stale display data only; the keys recover on their next poll or focus.
    console.error('[apple-store] billing cache revalidation failed', err);
  }
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** StoreKit products merged with the catalog (catalog order; unavailable ones dropped). */
export async function loadAppleProducts(): Promise<AppleStoreProduct[]> {
  const { products } = await PageSpaceStore.getProducts({ productIds: appleProductIds() });
  return mergeAppleProducts(APPLE_PRODUCTS, products ?? []);
}

/** Post a transaction, returning the HTTP status (0 for a network failure) and parsed body. */
async function postTransaction(jws: string): Promise<{ status: number; body: unknown }> {
  try {
    const body = await post<unknown>('/api/iap/apple/transactions', { signedTransaction: jws });
    return { status: 200, body };
  } catch (err) {
    if (err instanceof ApiRequestError) return { status: err.status, body: err.body };
    return { status: 0, body: undefined };
  }
}

// One server round-trip per transaction at a time: a purchase, the launch drain
// and a transactionUpdated event can all surface the same transaction at once.
const inFlight = new Map<string, Promise<AppleSyncResult>>();

/**
 * Send one transaction to the server and finish it per the contract. Concurrent
 * calls for the same transaction id share one round-trip.
 */
export function syncAppleTransaction(jws: string, transactionId: string): Promise<AppleSyncResult> {
  const existing = inFlight.get(transactionId);
  if (existing) return existing;

  const run = (async (): Promise<AppleSyncResult> => {
    const { status, body } = await postTransaction(jws);
    if (finishDecision(status) === 'finish') {
      try {
        await PageSpaceStore.finish({ transactionId });
      } catch (err) {
        // The server already has it; an unfinished transaction is redelivered and
        // the server answers 'duplicate', so this is safe to leave for next time.
        console.error('[apple-store] finish failed', err);
      }
    }
    return classifyTransactionResponse(status, body);
  })().finally(() => {
    inFlight.delete(transactionId);
  });

  inFlight.set(transactionId, run);
  return run;
}

/**
 * Buy a product: account token → StoreKit purchase → server → finish → refresh.
 * Never rejects; every failure comes back as `{ status: 'error' }`.
 */
export async function purchaseAppleProduct(productId: string): Promise<ApplePurchaseResult> {
  let accountToken: string;
  try {
    ({ accountToken } = await post<{ accountToken: string }>('/api/iap/apple/account-token', {}));
  } catch (err) {
    return { status: 'error', message: errorMessage(err, 'Could not start the purchase. Please try again.') };
  }

  let purchase: StoreKitPurchaseResult;
  try {
    purchase = await PageSpaceStore.purchase({ productId, appAccountToken: accountToken });
  } catch (err) {
    return { status: 'error', message: errorMessage(err, 'The App Store could not complete the purchase.') };
  }

  if (purchase.status !== 'success') return purchase;

  const sync = await syncAppleTransaction(purchase.jws, purchase.transactionId);
  if (sync.status === 'applied') await revalidateBillingCaches();
  return purchaseResultFromSync(sync);
}

export interface AppleSyncSummary {
  applied: number;
  refused: number;
  failed: number;
}

async function syncAll(transactions: readonly StoreKitTransaction[]): Promise<AppleSyncSummary> {
  const summary: AppleSyncSummary = { applied: 0, refused: 0, failed: 0 };
  for (const { jws, transactionId } of transactions) {
    const result = await syncAppleTransaction(jws, transactionId);
    if (result.status === 'applied') summary.applied += 1;
    else if (result.status === 'refused') summary.refused += 1;
    else summary.failed += 1;
  }
  if (summary.applied > 0) await revalidateBillingCaches();
  return summary;
}

/** Restore Purchases: AppStore.sync(), then send every current entitlement to the server. */
export async function restoreApplePurchases(): Promise<AppleSyncSummary> {
  const { transactions } = await PageSpaceStore.restore();
  return syncAll(transactions ?? []);
}

let draining: Promise<AppleSyncSummary> | null = null;

/** Send every unfinished transaction (interrupted purchases, Ask to Buy, renewals) to the server. */
export function drainUnfinished(): Promise<AppleSyncSummary> {
  if (draining) return draining;
  draining = (async () => {
    const { transactions } = await PageSpaceStore.unfinished();
    return syncAll(transactions ?? []);
  })().finally(() => {
    draining = null;
  });
  return draining;
}

/** Open Apple's Manage Subscriptions sheet. */
export async function manageAppleSubscriptions(): Promise<void> {
  await PageSpaceStore.manageSubscriptions();
}

let observers = 0;
let listenerHandle: Promise<PluginListenerHandle> | null = null;

async function onTransactionUpdated({ jws, transactionId }: StoreKitTransaction): Promise<void> {
  const result = await syncAppleTransaction(jws, transactionId);
  if (result.status === 'applied') await revalidateBillingCaches();
}

/**
 * Attach the `transactionUpdated` listener and drain unfinished transactions.
 * Reference-counted: the listener is attached once however many shells mount,
 * and removed when the last one stops. The plugin retains events until a
 * listener attaches, so a gap between unmount and remount loses nothing.
 */
export function startAppleTransactionObserver(): () => void {
  observers += 1;
  if (!listenerHandle) {
    listenerHandle = PageSpaceStore.addListener('transactionUpdated', (transaction) => {
      void onTransactionUpdated(transaction).catch((err) => {
        console.error('[apple-store] transactionUpdated sync failed', err);
      });
    });
    listenerHandle.catch((err) => {
      console.error('[apple-store] could not attach transactionUpdated listener', err);
      listenerHandle = null;
    });
  }
  void drainUnfinished().catch((err) => {
    console.error('[apple-store] draining unfinished transactions failed', err);
  });

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    observers -= 1;
    if (observers > 0 || !listenerHandle) return;
    const handle = listenerHandle;
    listenerHandle = null;
    void handle.then((h) => h.remove()).catch(() => undefined);
  };
}
