/**
 * apple-funding — the imperative shell that applies a VERIFIED App Store transaction to
 * the books. Every decision is made by apple-core; this file only does I/O, all of it in
 * one database transaction so a purchase is applied entirely or not at all.
 *
 * One entry point, {@link applyAppleTransaction}, serves both senders:
 *   - the device (POST /api/iap/apple/transactions) right after a purchase, a restore,
 *     or a `Transaction.updates` event — the user is the signed-in caller;
 *   - Apple (POST /api/iap/apple/notifications) for renewals, expiries and refunds — the
 *     user is resolved from the transaction's appAccountToken, else from the
 *     subscription already on file ({@link applyAppleNotification}).
 * Whichever arrives first applies; the other finds the work done. Exactly-once comes
 * from the credit ledger's partial unique index on stripeRef, keyed per Apple
 * transaction:
 *   apple:<transactionId>           the grant (a subscription period or a credit pack)
 *   apple-refund:<transactionId>    the clawback of that grant after a refund
 *   apple-reinstate:<transactionId> the re-grant after Apple reversed that refund
 * The user row is locked FOR UPDATE first — the same order the Stripe webhook and the
 * tier reconciler take — and the tier is re-derived across BOTH stores before it is
 * written, so neither store's events can demote a plan the other one sold.
 */

import { db } from '@pagespace/db/db';
import { and, eq, inArray, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { creditLedger } from '@pagespace/db/schema/credits';
import { wallets, personalRootWalletOf } from '@pagespace/db/schema/wallets';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { appStoreSubscriptions, appStoreTransactions } from '@pagespace/db/schema/app-store';
import { isBillingEnabled } from '../../deployment-mode';
import { loggers } from '../../logging/logger-config';
import { fundMonthlyGrant, fundTopup } from '../credit-funding';
import { ensurePersonalRootWalletId } from '../personal-wallet';
import type { SubscriptionTier } from '../subscription-tiers';
import { ENTITLED_SUBSCRIPTION_STATUSES, deriveTierFromSubscriptions, type PriceTierResolver } from '../subscription-tier-sync';
import { appleProduct } from './apple-products';
import { accountTokenForUser, userIdForAccountToken } from './apple-account';
import {
  allocateClawback,
  appleSubscriptionStatus,
  classifyAppleNotification,
  combineTiers,
  entitlementEndMs,
  planAppleTransaction,
  reconcileRevocation,
  toTransactionFacts,
  type AppleTransactionFacts,
  type DecodedTransactionLike,
  type RefuseReason,
} from './apple-core';
import { appleEntitledTier } from './apple-entitlement';
import type { VerifiedNotification, VerifiedRenewalInfo } from './apple-verify';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface AppleApplyConfig {
  bundleId: string;
  allowSandbox: boolean;
}

export type AppleApplyResult =
  | {
      result: 'applied' | 'duplicate';
      kind: 'subscription' | 'consumable' | 'revoked';
      subscriptionTier: SubscriptionTier;
    }
  | { result: 'refused'; reason: RefuseReason | 'not_billing' | 'owned_by_another_user' | 'unknown_user' };

export interface ApplyAppleTransactionInput {
  userId: string;
  decoded: DecodedTransactionLike;
  /** App Store status code from a server notification; null for a device sync. */
  notificationStatus?: number | null;
  renewal?: VerifiedRenewalInfo | null;
  /** Maps a Stripe price id to its tier — the Stripe half of the merged tier. */
  priceTier: PriceTierResolver;
  config: AppleApplyConfig;
  now?: Date;
}

const STRIPE_REF_ARBITER = {
  target: creditLedger.stripeRef,
  where: sql`${creditLedger.stripeRef} IS NOT NULL`,
} as const;

export const appleGrantRef = (transactionId: string) => `apple:${transactionId}`;
export const appleRefundRef = (transactionId: string) => `apple-refund:${transactionId}`;
export const appleReinstateRef = (transactionId: string) => `apple-reinstate:${transactionId}`;

async function ledgerRefExists(tx: Tx, ref: string): Promise<boolean> {
  const rows = await tx.select({ id: creditLedger.id }).from(creditLedger).where(eq(creditLedger.stripeRef, ref)).limit(1);
  return rows.length > 0;
}

/** Re-derive the user's tier across both stores and write it if it changed. */
async function writeMergedTier(tx: Tx, userId: string, priceTier: PriceTierResolver, now: Date, storedTier: string): Promise<SubscriptionTier> {
  const stripeRows = await tx
    .select({ status: subscriptions.status, stripePriceId: subscriptions.stripePriceId })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, [...ENTITLED_SUBSCRIPTION_STATUSES])));
  const stripeTier = deriveTierFromSubscriptions(stripeRows, priceTier).tier;
  const tier = combineTiers(stripeTier, await appleEntitledTier(tx, userId, now));
  if (storedTier !== tier) {
    await tx.update(users).set({ subscriptionTier: tier, updatedAt: now }).where(eq(users.id, userId));
  }
  return tier;
}

/**
 * Claw a refunded grant back out of the personal root: what the buckets hold leaves
 * them, the rest is owed as debt. Keyed on apple-refund:<transactionId>; returns
 * whether it was newly applied.
 */
async function clawBack(tx: Tx, input: { userId: string; transactionId: string; cents: number; first: 'monthly' | 'topup' }): Promise<boolean> {
  const walletId = await ensurePersonalRootWalletId(tx, input.userId);
  const [locked] = await tx
    .select({ monthlyRemainingCents: wallets.monthlyRemainingCents, topupRemainingCents: wallets.topupRemainingCents, debtCents: wallets.debtCents })
    .from(wallets)
    .where(personalRootWalletOf(input.userId))
    .for('update');
  const clawed = allocateClawback(
    { monthlyCents: locked?.monthlyRemainingCents ?? 0, topupCents: locked?.topupRemainingCents ?? 0 },
    input.cents,
    input.first,
  );
  const claimed = await tx
    .insert(creditLedger)
    .values({
      userId: input.userId,
      walletId,
      entryType: 'adjustment',
      bucket: input.first,
      amountCents: -clawed.appliedCents,
      appliedCents: -clawed.appliedCents,
      stripeRef: appleRefundRef(input.transactionId),
      consumeStatus: 'applied',
    })
    .onConflictDoNothing(STRIPE_REF_ARBITER)
    .returning({ id: creditLedger.id });
  if (claimed.length === 0) return false;
  if (clawed.debtCents > 0) {
    // The uncovered remainder is debt, recorded the way an uncovered charge is: a row that
    // applied nothing to the buckets and raises debtCents by its amount.
    await tx.insert(creditLedger).values({
      userId: input.userId,
      walletId,
      entryType: 'adjustment',
      bucket: input.first,
      amountCents: -clawed.debtCents,
      consumeStatus: 'applied',
    });
  }
  await tx
    .update(wallets)
    .set({
      monthlyRemainingCents: clawed.monthlyCents,
      topupRemainingCents: clawed.topupCents,
      debtCents: (locked?.debtCents ?? 0) + clawed.debtCents,
    })
    .where(personalRootWalletOf(input.userId));
  return true;
}

async function recordTransaction(tx: Tx, userId: string, facts: AppleTransactionFacts, kind: 'subscription' | 'consumable'): Promise<{ storedRevoked: boolean; isNew: boolean }> {
  const [existing] = await tx
    .select({ revokedAt: appStoreTransactions.revokedAt })
    .from(appStoreTransactions)
    .where(eq(appStoreTransactions.transactionId, facts.transactionId))
    .for('update');
  const revokedAt = facts.revocationDateMs === null ? null : new Date(facts.revocationDateMs);
  if (!existing) {
    await tx.insert(appStoreTransactions).values({
      transactionId: facts.transactionId,
      originalTransactionId: facts.originalTransactionId,
      userId,
      productId: facts.productId,
      productKind: kind,
      environment: facts.environment,
      purchaseDate: new Date(facts.purchaseDateMs),
      expiresDate: facts.expiresDateMs === null ? null : new Date(facts.expiresDateMs),
      priceMilliunits: facts.priceMilliunits,
      currency: facts.currency,
      storefront: facts.storefront,
      revokedAt,
    }).onConflictDoNothing({ target: appStoreTransactions.transactionId });
    return { storedRevoked: false, isNew: true };
  }
  if ((existing.revokedAt === null) !== (revokedAt === null)) {
    await tx.update(appStoreTransactions).set({ revokedAt }).where(eq(appStoreTransactions.transactionId, facts.transactionId));
  }
  return { storedRevoked: existing.revokedAt !== null, isNew: false };
}

async function upsertSubscription(tx: Tx, input: {
  userId: string;
  facts: AppleTransactionFacts;
  existing: { latestPurchaseMs: number } | null;
  notificationStatus: number | null;
  renewal: VerifiedRenewalInfo | null;
  now: Date;
}): Promise<void> {
  const { facts, now } = input;
  const expiresDateMs = facts.expiresDateMs ?? facts.purchaseDateMs;
  const status = appleSubscriptionStatus({ facts, notificationStatus: input.notificationStatus, nowMs: now.getTime() });
  const expiresAt = new Date(entitlementEndMs({ expiresDateMs, gracePeriodExpiresMs: input.renewal?.gracePeriodExpiresMs ?? null, status }));
  if (!input.existing) {
    await tx.insert(appStoreSubscriptions).values({
      userId: input.userId,
      originalTransactionId: facts.originalTransactionId,
      latestTransactionId: facts.transactionId,
      productId: facts.productId,
      status,
      environment: facts.environment,
      currentPeriodStart: new Date(facts.purchaseDateMs),
      expiresAt,
      autoRenew: input.renewal?.autoRenew ?? true,
    }).onConflictDoNothing({ target: appStoreSubscriptions.originalTransactionId });
    return;
  }
  // An older period arriving late (a refund of last month, a replayed sync) updates its own
  // transaction's books only; the subscription's state follows its latest period.
  if (facts.purchaseDateMs < input.existing.latestPurchaseMs) {
    if (input.renewal) {
      await tx.update(appStoreSubscriptions).set({ autoRenew: input.renewal.autoRenew, updatedAt: now })
        .where(eq(appStoreSubscriptions.originalTransactionId, facts.originalTransactionId));
    }
    return;
  }
  await tx.update(appStoreSubscriptions).set({
    latestTransactionId: facts.transactionId,
    productId: facts.productId,
    status,
    environment: facts.environment,
    currentPeriodStart: new Date(facts.purchaseDateMs),
    expiresAt,
    ...(input.renewal ? { autoRenew: input.renewal.autoRenew } : {}),
    updatedAt: now,
  }).where(eq(appStoreSubscriptions.originalTransactionId, facts.originalTransactionId));
}

/** Apply one verified transaction for `userId`. */
export async function applyAppleTransaction(input: ApplyAppleTransactionInput): Promise<AppleApplyResult> {
  if (!isBillingEnabled()) return { result: 'refused', reason: 'not_billing' };
  const facts = toTransactionFacts(input.decoded);
  if (!facts) return { result: 'refused', reason: 'malformed' };
  const now = input.now ?? new Date();
  const { userId } = input;

  return db.transaction(async (tx): Promise<AppleApplyResult> => {
    // Shared lock order with the Stripe webhook and the tier reconciler: user, then mirror.
    const [user] = await tx.select({ id: users.id, subscriptionTier: users.subscriptionTier }).from(users).where(eq(users.id, userId)).for('update');
    if (!user) return { result: 'refused', reason: 'unknown_user' };

    const [owned] = await tx
      .select({ userId: appStoreSubscriptions.userId, currentPeriodStart: appStoreSubscriptions.currentPeriodStart })
      .from(appStoreSubscriptions)
      .where(eq(appStoreSubscriptions.originalTransactionId, facts.originalTransactionId))
      .for('update');
    if (owned && owned.userId !== userId) return { result: 'refused', reason: 'owned_by_another_user' };

    const plan = planAppleTransaction(facts, {
      bundleId: input.config.bundleId,
      allowSandbox: input.config.allowSandbox,
      expectedAccountToken: await accountTokenForUser(tx, userId),
      ownershipEstablished: owned?.userId === userId,
    });
    if (plan.kind === 'refuse') return { result: 'refused', reason: plan.reason };

    const product = appleProduct(facts.productId);
    const productKind = product?.kind === 'subscription' ? 'subscription' : 'consumable';
    const recorded = await recordTransaction(tx, userId, facts, productKind);
    const revocation = recorded.isNew
      ? (facts.revocationDateMs !== null ? 'revoke' : 'none')
      : reconcileRevocation({ storedRevoked: recorded.storedRevoked, factsRevoked: facts.revocationDateMs !== null });

    if (productKind === 'subscription') {
      await upsertSubscription(tx, {
        userId,
        facts,
        existing: owned ? { latestPurchaseMs: owned.currentPeriodStart.getTime() } : null,
        notificationStatus: input.notificationStatus ?? null,
        renewal: input.renewal ?? null,
        now,
      });
    }

    let applied = false;
    switch (plan.kind) {
      case 'subscription_period': {
        if (plan.allowanceCents > 0) {
          const funded = await fundMonthlyGrant(tx, {
            userId,
            fundingRef: appleGrantRef(facts.transactionId),
            allowanceCents: plan.allowanceCents,
            paidCents: plan.paidCents,
            periodStart: new Date(plan.periodStartMs),
            periodEnd: new Date(plan.periodEndMs),
          });
          applied = funded.applied;
        }
        if (revocation === 'reinstate' && plan.allowanceCents > 0 && await ledgerRefExists(tx, appleRefundRef(facts.transactionId))) {
          const reinstated = await fundMonthlyGrant(tx, {
            userId,
            fundingRef: appleReinstateRef(facts.transactionId),
            allowanceCents: plan.allowanceCents,
            paidCents: plan.paidCents,
            periodStart: null,
            periodEnd: null,
          });
          applied = applied || reinstated.applied;
        }
        break;
      }
      case 'consumable': {
        applied = (await fundTopup(tx, { userId, fundingRef: appleGrantRef(facts.transactionId), topupCents: plan.topupCents })).applied;
        if (revocation === 'reinstate' && await ledgerRefExists(tx, appleRefundRef(facts.transactionId))) {
          const reinstated = await fundTopup(tx, { userId, fundingRef: appleReinstateRef(facts.transactionId), topupCents: plan.topupCents });
          applied = applied || reinstated.applied;
        }
        break;
      }
      case 'revoke_subscription':
      case 'revoke_consumable': {
        // Only what this transaction actually granted is clawed back: a refund for a
        // transaction we never funded (or a $0 period) takes nothing.
        if (plan.clawbackCents > 0 && await ledgerRefExists(tx, appleGrantRef(facts.transactionId))) {
          applied = await clawBack(tx, {
            userId,
            transactionId: facts.transactionId,
            cents: plan.clawbackCents,
            first: plan.kind === 'revoke_subscription' ? 'monthly' : 'topup',
          });
        }
        break;
      }
    }

    const subscriptionTier = await writeMergedTier(tx, userId, input.priceTier, now, user.subscriptionTier);
    const kind = plan.kind === 'revoke_subscription' || plan.kind === 'revoke_consumable' ? 'revoked' : productKind;
    return { result: applied || recorded.isNew ? 'applied' : 'duplicate', kind, subscriptionTier };
  });
}

export type AppleNotificationResult =
  | AppleApplyResult
  | { result: 'test' }
  | { result: 'ignored'; reason: 'type' | 'no_transaction' };

/**
 * Apply a verified App Store Server Notification: resolve its buyer from the
 * transaction's account token, else from the subscription already on file, and apply
 * the signed transaction it carries.
 */
export async function applyAppleNotification(input: {
  notification: VerifiedNotification;
  priceTier: PriceTierResolver;
  config: AppleApplyConfig;
  now?: Date;
}): Promise<AppleNotificationResult> {
  const { notification } = input;
  const route = classifyAppleNotification(notification.type);
  if (route === 'test') return { result: 'test' };
  if (route === 'ignore') return { result: 'ignored', reason: 'type' };
  if (!notification.transaction) return { result: 'ignored', reason: 'no_transaction' };

  const facts = toTransactionFacts(notification.transaction);
  if (!facts) return { result: 'refused', reason: 'malformed' };

  let userId = facts.appAccountToken ? await userIdForAccountToken(db, facts.appAccountToken) : null;
  if (!userId) {
    const [owned] = await db
      .select({ userId: appStoreSubscriptions.userId })
      .from(appStoreSubscriptions)
      .where(eq(appStoreSubscriptions.originalTransactionId, facts.originalTransactionId))
      .limit(1);
    userId = owned?.userId ?? null;
  }
  if (!userId) {
    loggers.api.warn('App Store notification for an unknown buyer', {
      notificationUUID: notification.notificationUUID,
      type: notification.type,
      transactionId: facts.transactionId,
    });
    return { result: 'refused', reason: 'unknown_user' };
  }

  return applyAppleTransaction({
    userId,
    decoded: notification.transaction,
    notificationStatus: notification.status,
    renewal: notification.renewal,
    priceTier: input.priceTier,
    config: input.config,
    now: input.now,
  });
}
