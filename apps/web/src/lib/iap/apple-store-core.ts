/**
 * Apple In-App Purchase — the pure half: the PageSpaceStore plugin's wire types,
 * and the decisions the effectful client (`apple-store.ts`) makes from them.
 * No Capacitor, no fetch, no React — everything here is unit-tested directly.
 */

import type { AppleProduct } from '@pagespace/lib/billing/apple/apple-products';

/** jsName the native StoreKit 2 plugin registers under (MyViewController.swift). */
export const PAGESPACE_STORE_PLUGIN = 'PageSpaceStore';

export type StoreKitProductType = 'autoRenewable' | 'consumable' | 'nonConsumable' | 'nonRenewable';
export type StoreKitPeriodUnit = 'day' | 'week' | 'month' | 'year';

export interface StoreKitSubscriptionPeriod {
  unit: StoreKitPeriodUnit;
  value: number;
}

/** A product as StoreKit returns it — localized for the user's storefront. */
export interface StoreKitProduct {
  id: string;
  displayName: string;
  description: string;
  /** Localized, currency-formatted price. The ONLY price the device may show. */
  displayPrice: string;
  /** Decimal string. */
  price: string;
  currencyCode: string;
  type: StoreKitProductType;
  subscriptionPeriod?: StoreKitSubscriptionPeriod;
}

/** A verified transaction the plugin surfaced: its JWS and id. */
export interface StoreKitTransaction {
  jws: string;
  transactionId: string;
  /**
   * StoreKit's own on-device check. Informational only: unverified transactions are posted
   * too, and the server — which verifies every JWS — decides (400 → finished).
   */
  verifiedOnDevice?: boolean;
}

export type StoreKitPurchaseResult =
  | ({ status: 'success' } & StoreKitTransaction)
  | { status: 'cancelled' }
  | { status: 'pending' };

/** A catalog product StoreKit actually returned, with its localized display fields. */
export type AppleStoreProduct = AppleProduct & {
  displayName: string;
  description: string;
  displayPrice: string;
  subscriptionPeriod?: StoreKitSubscriptionPeriod;
};

/**
 * Merge the catalog with what StoreKit returned, by product id. Catalog order is
 * kept; a catalog entry StoreKit did not return (not approved in App Store
 * Connect yet, unavailable in this storefront) is dropped — it cannot be bought.
 * A StoreKit product we have no catalog entry for is ignored.
 */
export function mergeAppleProducts(
  catalog: readonly AppleProduct[],
  storeKitProducts: readonly StoreKitProduct[],
): AppleStoreProduct[] {
  const byId = new Map(storeKitProducts.map((p) => [p.id, p]));
  const merged: AppleStoreProduct[] = [];
  for (const entry of catalog) {
    const sk = byId.get(entry.productId);
    if (!sk) continue;
    merged.push({
      ...entry,
      displayName: sk.displayName,
      description: sk.description,
      displayPrice: sk.displayPrice,
      ...(sk.subscriptionPeriod ? { subscriptionPeriod: sk.subscriptionPeriod } : {}),
    });
  }
  return merged;
}

/** "/month", "/year", "/3 months" — the suffix after a subscription's price. Empty for one-time products. */
export function formatSubscriptionPeriod(period: StoreKitSubscriptionPeriod | undefined): string {
  if (!period || !Number.isFinite(period.value) || period.value <= 0) return '';
  return period.value === 1 ? `/${period.unit}` : `/${period.value} ${period.unit}s`;
}

/** StoreKit's localized price plus the period suffix, e.g. "€19,99/month". */
export function formatAppleProductPrice(product: Pick<AppleStoreProduct, 'displayPrice' | 'subscriptionPeriod'>): string {
  return `${product.displayPrice}${formatSubscriptionPeriod(product.subscriptionPeriod)}`;
}

/**
 * After posting a transaction to the server, finish it or keep it for a retry.
 *
 * 2xx: applied (or a duplicate) — finish. 400: an unverifiable JWS will never
 * verify — finish. 422: a permanent refusal (another account's transaction;
 * Apple's server notifications still credit the real owner) — finish. Anything
 * else (401/403/5xx, or 0 for a network failure) — do NOT finish: StoreKit keeps
 * it in `Transaction.unfinished` and we retry on the next launch or update.
 */
export function finishDecision(httpStatus: number): 'finish' | 'retry' {
  if (httpStatus >= 200 && httpStatus < 300) return 'finish';
  if (httpStatus === 400 || httpStatus === 422) return 'finish';
  return 'retry';
}

/** The server's 2xx answer to POST /api/iap/apple/transactions. */
export interface AppleTransactionApplied {
  result: 'applied' | 'duplicate';
  kind: 'subscription' | 'consumable' | 'revoked';
  subscriptionTier: 'free' | 'pro';
}

/** What syncing one transaction with the server came to. */
export type AppleSyncResult =
  | { status: 'applied'; data: AppleTransactionApplied }
  | { status: 'refused'; reason: string | null }
  | { status: 'invalid' }
  | { status: 'retry'; httpStatus: number };

/** Classify the server's answer (status + parsed body) to a transaction POST. Pure. */
export function classifyTransactionResponse(httpStatus: number, body: unknown): AppleSyncResult {
  if (httpStatus >= 200 && httpStatus < 300) {
    return { status: 'applied', data: body as AppleTransactionApplied };
  }
  if (httpStatus === 422) {
    const reason = body && typeof body === 'object' && 'reason' in body && typeof body.reason === 'string' ? body.reason : null;
    return { status: 'refused', reason };
  }
  if (httpStatus === 400) return { status: 'invalid' };
  return { status: 'retry', httpStatus };
}

/** Result of a user-initiated purchase. Success is only reported after the server confirms. */
export type ApplePurchaseResult =
  | { status: 'success'; subscriptionTier: 'free' | 'pro'; kind: AppleTransactionApplied['kind'] }
  | { status: 'cancelled' }
  | { status: 'pending' }
  | { status: 'refused'; reason: string | null }
  | { status: 'error'; message: string };

/** Map a server sync result onto the purchase result the UI shows. Pure. */
export function purchaseResultFromSync(sync: AppleSyncResult): ApplePurchaseResult {
  switch (sync.status) {
    case 'applied':
      return { status: 'success', subscriptionTier: sync.data.subscriptionTier, kind: sync.data.kind };
    case 'refused':
      return { status: 'refused', reason: sync.reason };
    case 'invalid':
      return { status: 'error', message: 'The App Store purchase could not be verified.' };
    case 'retry':
      return {
        status: 'error',
        message: "Your purchase went through but we couldn't confirm it yet. It will be applied automatically — check back shortly.",
      };
  }
}

/** The user-facing line for a purchase result, or null when nothing should be said (cancelled). */
export function purchaseResultMessage(result: ApplePurchaseResult): { tone: 'success' | 'info' | 'error'; text: string } | null {
  switch (result.status) {
    case 'success':
      return { tone: 'success', text: result.kind === 'consumable' ? 'Credits added.' : 'Your subscription is active.' };
    case 'cancelled':
      return null;
    case 'pending':
      return { tone: 'info', text: 'Your purchase is pending approval. It will be applied once approved.' };
    case 'refused':
      return {
        tone: 'error',
        text: result.reason === 'account_mismatch' || result.reason === 'owned_by_another_user'
          ? 'This App Store purchase belongs to a different PageSpace account.'
          : "This App Store purchase couldn't be applied to your account. If you were charged, contact support.",
      };
    case 'error':
      return { tone: 'error', text: result.message };
  }
}

/** The Pro subscription among loaded products, if StoreKit returned it. */
export function appleProProduct(products: readonly AppleStoreProduct[]): AppleStoreProduct | undefined {
  return products.find((p) => p.kind === 'subscription' && p.tier === 'pro');
}

/** The credit packs among loaded products, in catalog order. */
export function appleCreditPacks(products: readonly AppleStoreProduct[]): AppleStoreProduct[] {
  return products.filter((p) => p.kind === 'consumable');
}

/** Who sells the user's current paid personal plan (GET /api/subscriptions/status). */
export type BillingProvider = 'stripe' | 'apple' | null;

/** The App Store subscription summary GET /api/subscriptions/status carries. */
export interface AppStoreSubscriptionSummary {
  status: string;
  productId: string;
  expiresAt: string | null;
  autoRenew: boolean;
  environment: string;
}

/**
 * What the Pro card offers on the Apple channel. Pure.
 *
 * - `subscribe`: a free user — Subscribe through In-App Purchase.
 * - `manage`: an App Store subscriber — Manage Subscription (Apple's sheet).
 * - `managed-on-web`: a Stripe subscriber — text only; no button, no link, no URL.
 * - `managed-by-org`: an organization's plan — text only.
 * - `included`: a paid tier from neither store (granted) — text only.
 */
export type ApplePlanAction = 'subscribe' | 'manage' | 'managed-on-web' | 'managed-by-org' | 'included';

export function applePlanAction({
  subscriptionTier,
  billingProvider,
}: {
  subscriptionTier: string;
  billingProvider: BillingProvider | undefined;
}): ApplePlanAction {
  if (billingProvider === 'apple') return 'manage';
  if (billingProvider === 'stripe') return 'managed-on-web';
  if (subscriptionTier === 'business') return 'managed-by-org';
  if (subscriptionTier !== 'free') return 'included';
  return 'subscribe';
}

/**
 * Dispatched on `window` after the server confirmed an App Store transaction changed the
 * account — including ones that complete in the background (Ask to Buy, renewals) — so
 * views that hold billing state outside SWR refetch it.
 */
export const APPLE_BILLING_CHANGED_EVENT = 'pagespace:apple-billing-changed';

/**
 * The Terms of Use the App Store paywall links (App Review 3.1.2): Apple's standard EULA.
 * Our own /terms page states web prices and links to web checkout, which the iOS paywall
 * must never show (3.1.1 / 3.1.3).
 */
export const APPLE_STANDARD_EULA_URL = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';

/** Auto-renewal disclosure shown next to the App Store subscription (App Review 3.1.2). */
export const APPLE_AUTO_RENEW_DISCLOSURE =
  'Payment is charged to your Apple ID at confirmation. Subscription renews automatically each month unless cancelled at least 24 hours before the end of the period. Manage or cancel in your App Store account settings.';

/** Shown on the web when the user's plan was bought through the App Store. */
export const MANAGED_IN_APP_STORE_TITLE = 'Managed in the App Store';
export const MANAGED_IN_APP_STORE_DETAIL =
  'Your subscription was purchased through the App Store. Manage or cancel it on your iPhone or iPad: Settings › Apple ID › Subscriptions.';

/** Shown in the iOS app when the user's plan is billed through Stripe. No link, no URL (anti-steering). */
export const MANAGED_ON_WEB_TEXT = 'Your plan is managed on the web.';

export const ORG_PLAN_MANAGED_TEXT = "Organization plans are managed by your organization's admin.";
