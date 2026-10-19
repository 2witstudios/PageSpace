/**
 * apple-core — pure decisions for App Store (StoreKit 2) purchases. No I/O: the
 * verification shell (apple-verify) turns signed JWS into decoded payloads, the funding
 * shell (apple-funding) applies what these functions plan. Modeled on classifyStripeEvent
 * / grantForInvoice: every money decision is a pure function with its own tests.
 *
 * The rules:
 *   - A transaction is honoured only when it is ours (bundle id), real money or a
 *     deliberately allowed Sandbox purchase, bought by this user (their App Store account
 *     token, or — for a token-less transaction — a subscription they already own), and
 *     for a product in the catalog. Each refusal names its reason.
 *   - A subscription period grants what the SAME plan grants on the web: sized from the
 *     web list price (apple-products webEquivalentCents) through allowanceCentsForPaidCents,
 *     never from Apple's price, so the upcharge covers Apple's commission and never buys
 *     more credit. A period Apple charged nothing for grants nothing, as a $0 invoice.
 *   - A refund claws back exactly what the transaction granted; what the balance cannot
 *     cover becomes debt, the same as an uncovered charge.
 *   - A subscription entitles only while its status is active (or in a billing grace
 *     period) AND its paid period has not ended, so a missed EXPIRED notification can
 *     never hold a tier open.
 */

import type { AppStoreEnvironment, AppStoreSubscriptionStatus } from '@pagespace/db/schema/app-store';
import { allowanceCentsForPaidCents } from '../money-model';
import { tierRank, type SubscriptionTier } from '../subscription-tiers';
import { appleProduct } from './apple-products';

/** Structural subset of Apple's JWSTransactionDecodedPayload the planner reads. */
export interface DecodedTransactionLike {
  transactionId?: string;
  originalTransactionId?: string;
  productId?: string;
  bundleId?: string;
  environment?: string;
  purchaseDate?: number;
  expiresDate?: number;
  revocationDate?: number;
  appAccountToken?: string;
  price?: number;
  currency?: string;
  storefront?: string;
  inAppOwnershipType?: string;
}

/** A verified transaction, normalized. Dates are epoch milliseconds. */
export interface AppleTransactionFacts {
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  bundleId: string;
  environment: AppStoreEnvironment;
  purchaseDateMs: number;
  expiresDateMs: number | null;
  revocationDateMs: number | null;
  /** Lower-cased UUID, or null when the purchase carried none. */
  appAccountToken: string | null;
  /** Apple's price in milliunits of `currency`; null when Apple sent none. */
  priceMilliunits: number | null;
  currency: string | null;
  storefront: string | null;
  familyShared: boolean;
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function toEnvironment(value: unknown): AppStoreEnvironment | null {
  return value === 'Production' || value === 'Sandbox' ? value : null;
}

/**
 * Normalize a decoded transaction, or null when it lacks an identity field or comes from
 * an environment no real purchase or App Review purchase is signed in (Xcode, LocalTesting).
 */
export function toTransactionFacts(decoded: DecodedTransactionLike): AppleTransactionFacts | null {
  const environment = toEnvironment(decoded.environment);
  if (
    !nonEmpty(decoded.transactionId) ||
    !nonEmpty(decoded.originalTransactionId) ||
    !nonEmpty(decoded.productId) ||
    !nonEmpty(decoded.bundleId) ||
    !finite(decoded.purchaseDate) ||
    environment === null
  ) {
    return null;
  }
  return {
    transactionId: decoded.transactionId,
    originalTransactionId: decoded.originalTransactionId,
    productId: decoded.productId,
    bundleId: decoded.bundleId,
    environment,
    purchaseDateMs: decoded.purchaseDate,
    expiresDateMs: finite(decoded.expiresDate) ? decoded.expiresDate : null,
    revocationDateMs: finite(decoded.revocationDate) ? decoded.revocationDate : null,
    appAccountToken: nonEmpty(decoded.appAccountToken) ? decoded.appAccountToken.toLowerCase() : null,
    priceMilliunits: finite(decoded.price) ? decoded.price : null,
    currency: nonEmpty(decoded.currency) ? decoded.currency : null,
    storefront: nonEmpty(decoded.storefront) ? decoded.storefront : null,
    familyShared: decoded.inAppOwnershipType === 'FAMILY_SHARED',
  };
}

export interface PlanContext {
  /** The app's bundle id (ai.pagespace.ios). */
  bundleId: string;
  /** Whether Sandbox-signed purchases fund anything on this deployment. */
  allowSandbox: boolean;
  /** The App Store account token of the user this transaction would be applied to. */
  expectedAccountToken: string | null;
  /** Whether that user already owns this originalTransactionId. */
  ownershipEstablished: boolean;
}

export type RefuseReason =
  | 'wrong_bundle'
  | 'sandbox_refused'
  | 'family_shared'
  | 'account_mismatch'
  | 'unknown_product'
  | 'malformed';

export type AppleTransactionPlan =
  | {
      kind: 'subscription_period';
      productId: string;
      tier: SubscriptionTier;
      /** The web-equivalent price recorded on the grant row (credit_ledger.paidCents). */
      paidCents: number;
      allowanceCents: number;
      periodStartMs: number;
      periodEndMs: number;
    }
  | { kind: 'revoke_subscription'; productId: string; clawbackCents: number }
  | { kind: 'consumable'; productId: string; topupCents: number }
  | { kind: 'revoke_consumable'; productId: string; clawbackCents: number }
  | { kind: 'refuse'; reason: RefuseReason };

function ownedByCaller(facts: AppleTransactionFacts, ctx: PlanContext): boolean {
  if (facts.appAccountToken === null) return ctx.ownershipEstablished;
  return ctx.expectedAccountToken !== null && facts.appAccountToken === ctx.expectedAccountToken.toLowerCase();
}

/** Decide what a verified transaction does for the user in `ctx`. */
export function planAppleTransaction(facts: AppleTransactionFacts, ctx: PlanContext): AppleTransactionPlan {
  if (facts.bundleId !== ctx.bundleId) return { kind: 'refuse', reason: 'wrong_bundle' };
  if (facts.environment === 'Sandbox' && !ctx.allowSandbox) return { kind: 'refuse', reason: 'sandbox_refused' };
  if (facts.familyShared) return { kind: 'refuse', reason: 'family_shared' };
  if (!ownedByCaller(facts, ctx)) return { kind: 'refuse', reason: 'account_mismatch' };

  const product = appleProduct(facts.productId);
  if (!product) return { kind: 'refuse', reason: 'unknown_product' };
  const revoked = facts.revocationDateMs !== null;

  if (product.kind === 'consumable') {
    return revoked
      ? { kind: 'revoke_consumable', productId: product.productId, clawbackCents: product.topupCents }
      : { kind: 'consumable', productId: product.productId, topupCents: product.topupCents };
  }

  if (facts.expiresDateMs === null) return { kind: 'refuse', reason: 'malformed' };
  const charged = facts.priceMilliunits === null || facts.priceMilliunits > 0;
  const paidCents = charged ? product.webEquivalentCents : 0;
  const allowanceCents = allowanceCentsForPaidCents(paidCents, product.tier);
  if (revoked) return { kind: 'revoke_subscription', productId: product.productId, clawbackCents: allowanceCents };
  return {
    kind: 'subscription_period',
    productId: product.productId,
    tier: product.tier,
    paidCents,
    allowanceCents,
    periodStartMs: facts.purchaseDateMs,
    periodEndMs: facts.expiresDateMs,
  };
}

/** Apple's subscription status codes (App Store Server API `status`). */
const STATUS_BY_CODE: Record<number, AppStoreSubscriptionStatus> = {
  1: 'active',
  2: 'expired',
  3: 'billing_retry',
  4: 'grace_period',
  5: 'revoked',
};

/**
 * The status to mirror for a subscription transaction: revoked when Apple revoked it;
 * otherwise the notification's status when it carried one, else by expiry.
 */
export function appleSubscriptionStatus(input: {
  facts: AppleTransactionFacts;
  notificationStatus: number | null;
  nowMs: number;
}): AppStoreSubscriptionStatus {
  if (input.facts.revocationDateMs !== null) return 'revoked';
  const fromNotification = input.notificationStatus === null ? undefined : STATUS_BY_CODE[input.notificationStatus];
  if (fromNotification) return fromNotification;
  return (input.facts.expiresDateMs ?? 0) > input.nowMs ? 'active' : 'expired';
}

/** When access ends: the paid period end, extended through a billing grace period. */
export function entitlementEndMs(input: {
  expiresDateMs: number;
  gracePeriodExpiresMs: number | null;
  status: AppStoreSubscriptionStatus;
}): number {
  if (input.status === 'grace_period' && input.gracePeriodExpiresMs !== null) {
    return Math.max(input.expiresDateMs, input.gracePeriodExpiresMs);
  }
  return input.expiresDateMs;
}

const ENTITLING_STATUSES: ReadonlySet<string> = new Set(['active', 'grace_period']);

export interface AppleSubscriptionRowLike {
  status: string;
  productId: string;
  expiresAtMs: number;
}

/** Whether a mirrored subscription entitles its tier at `nowMs`. */
export function appleRowEntitles(row: Pick<AppleSubscriptionRowLike, 'status' | 'expiresAtMs'>, nowMs: number): boolean {
  return ENTITLING_STATUSES.has(row.status) && row.expiresAtMs > nowMs;
}

/** The highest tier the user's App Store subscriptions entitle at `nowMs`. */
export function deriveTierFromAppleSubscriptions(rows: readonly AppleSubscriptionRowLike[], nowMs: number): SubscriptionTier {
  let tier: SubscriptionTier = 'free';
  for (const row of rows) {
    if (!appleRowEntitles(row, nowMs)) continue;
    const product = appleProduct(row.productId);
    if (product?.kind !== 'subscription') continue;
    if (tierRank(product.tier) > tierRank(tier)) tier = product.tier;
  }
  return tier;
}

/** The highest of the tiers each store entitles — a plan is one fact whichever store sold it. */
export function combineTiers(...tiers: SubscriptionTier[]): SubscriptionTier {
  return tiers.reduce<SubscriptionTier>((best, tier) => (tierRank(tier) > tierRank(best) ? tier : best), 'free');
}

export interface ClawbackResult {
  monthlyCents: number;
  topupCents: number;
  /** What left the buckets. */
  appliedCents: number;
  /** What the buckets could not cover — owed as debt. */
  debtCents: number;
}

/**
 * Take a refunded grant back out of the balance: from the bucket the grant landed in
 * first, then the other, clamping each at zero; the remainder is owed as debt.
 */
export function allocateClawback(
  balance: { monthlyCents: number; topupCents: number },
  amountCents: number,
  first: 'monthly' | 'topup',
): ClawbackResult {
  const amount = Math.max(0, Math.round(amountCents));
  const order: Array<'monthlyCents' | 'topupCents'> = first === 'monthly' ? ['monthlyCents', 'topupCents'] : ['topupCents', 'monthlyCents'];
  const next = { monthlyCents: balance.monthlyCents, topupCents: balance.topupCents };
  let remaining = amount;
  for (const bucket of order) {
    const taken = Math.min(Math.max(0, next[bucket]), remaining);
    next[bucket] -= taken;
    remaining -= taken;
  }
  return { ...next, appliedCents: amount - remaining, debtCents: remaining };
}

/** What a transaction's revocation state asks of the books, against what they recorded. */
export function reconcileRevocation(input: { storedRevoked: boolean; factsRevoked: boolean }): 'revoke' | 'reinstate' | 'none' {
  if (input.factsRevoked && !input.storedRevoked) return 'revoke';
  if (!input.factsRevoked && input.storedRevoked) return 'reinstate';
  return 'none';
}

/** Notification types whose signed transaction changes something we mirror. */
const TRANSACTION_NOTIFICATIONS: ReadonlySet<string> = new Set([
  'SUBSCRIBED',
  'DID_RENEW',
  'DID_CHANGE_RENEWAL_STATUS',
  'DID_CHANGE_RENEWAL_PREF',
  'DID_FAIL_TO_RENEW',
  'GRACE_PERIOD_EXPIRED',
  'EXPIRED',
  'REFUND',
  'REVOKE',
  'REFUND_REVERSED',
  'ONE_TIME_CHARGE',
  'RENEWAL_EXTENDED',
  'OFFER_REDEEMED',
]);

/** Route an App Store Server Notification V2 by its type. */
export function classifyAppleNotification(type: string | undefined): 'test' | 'transaction' | 'ignore' {
  if (type === 'TEST') return 'test';
  return type !== undefined && TRANSACTION_NOTIFICATIONS.has(type) ? 'transaction' : 'ignore';
}
