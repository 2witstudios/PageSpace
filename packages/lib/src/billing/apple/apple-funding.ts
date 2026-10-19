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
 *   apple-refund:<transactionId>:<revokedAtMs>    the clawback of that grant, per refund
 *   apple-reinstate:<transactionId>:<revokedAtMs> the re-grant after Apple reversed that refund
 * Payloads are ordered by Apple's signedDate: one signed before the newest already
 * applied (a replayed pre-refund receipt, a delayed notification retry) changes nothing,
 * and only a verified REFUND_REVERSED notification can undo a refund.
 * The user row is locked FOR UPDATE first — the same order the Stripe webhook and the
 * tier reconciler take — and the tier is re-derived across BOTH stores before it is
 * written, so neither store's events can demote a plan the other one sold.
 */

import { db } from '@pagespace/db/db';
import { and, eq, gt, inArray, sql } from '@pagespace/db/operators';
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
  isStalePayload,
  nextSubscriptionState,
  planAppleTransaction,
  reconcileRevocation,
  sandboxFundingAllowed,
  toTransactionFacts,
  type SubscriptionStateOnFile,
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
  /** Sandbox purchases that may fund credit per user per window (sandboxFundingAllowed). */
  sandboxMaxFundings: number;
  /** User ids whose Sandbox purchases always fund (internal testers). */
  sandboxAllowlist: readonly string[];
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
  /** Who sent it: the signed-in buyer's device, or Apple. */
  source: 'device' | 'notification';
  /** The notification type when `source` is 'notification'. */
  notificationType?: string;
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
/** One clawback per refund, keyed by its revocation instant (a refund after a reversal is a new one). */
export const appleRefundRef = (transactionId: string, revokedAtMs: number) => `apple-refund:${transactionId}:${revokedAtMs}`;
/** The re-grant after Apple reversed the refund at `revokedAtMs`. */
export const appleReinstateRef = (transactionId: string, revokedAtMs: number) => `apple-reinstate:${transactionId}:${revokedAtMs}`;

async function ledgerRefExists(tx: Tx, ref: string): Promise<boolean> {
  return (await ledgerAmountCents(tx, ref)) !== null;
}

/**
 * What the ledger row keyed `ref` recorded, or null when there is none. A refund claws back
 * — and a reversal re-grants — exactly what the purchase was credited at the time, never the
 * current catalog's figure (a pack or price can change after it was bought).
 */
async function ledgerAmountCents(tx: Tx, ref: string): Promise<number | null> {
  const rows = await tx.select({ amountCents: creditLedger.amountCents }).from(creditLedger).where(eq(creditLedger.stripeRef, ref)).limit(1);
  return rows[0]?.amountCents ?? null;
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
 * them, the rest is owed as debt. Keyed on apple-refund:<transactionId>:<revokedAtMs>; returns
 * whether it was newly applied.
 */
async function clawBack(tx: Tx, input: { userId: string; fundingRef: string; cents: number; first: 'monthly' | 'topup' }): Promise<boolean> {
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
      stripeRef: input.fundingRef,
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

interface RecordedTransaction {
  isNew: boolean;
  /** The payload is older than the newest one applied to this transaction: it changes nothing. */
  stale: boolean;
  /** The revocation instant on file BEFORE this payload. */
  storedRevokedAtMs: number | null;
  /** Whether this transaction has funded credit (counts toward the Sandbox cap). */
  funded: boolean;
}

async function readTransaction(tx: Tx, userId: string, facts: AppleTransactionFacts, kind: 'subscription' | 'consumable'): Promise<RecordedTransaction> {
  const [existing] = await tx
    .select({ revokedAt: appStoreTransactions.revokedAt, lastSignedAt: appStoreTransactions.lastSignedAt, funded: appStoreTransactions.funded })
    .from(appStoreTransactions)
    .where(eq(appStoreTransactions.transactionId, facts.transactionId))
    .for('update');
  if (existing) {
    return {
      isNew: false,
      stale: isStalePayload({ lastSignedMs: existing.lastSignedAt?.getTime() ?? null, signedMs: facts.signedDateMs }),
      storedRevokedAtMs: existing.revokedAt?.getTime() ?? null,
      funded: existing.funded,
    };
  }
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
    lastSignedAt: facts.signedDateMs === null ? null : new Date(facts.signedDateMs),
  }).onConflictDoNothing({ target: appStoreTransactions.transactionId });
  return { isNew: true, stale: false, storedRevokedAtMs: null, funded: false };
}

/** Sandbox transactions of this user that funded credit inside the cap window. */
async function recentSandboxFundings(tx: Tx, userId: string, now: Date): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(appStoreTransactions)
    .where(and(
      eq(appStoreTransactions.userId, userId),
      eq(appStoreTransactions.environment, 'Sandbox'),
      eq(appStoreTransactions.funded, true),
      gt(appStoreTransactions.createdAt, new Date(now.getTime() - SANDBOX_FUNDING_WINDOW_MS)),
    ));
  return row?.n ?? 0;
}

/** The rolling window the Sandbox funding cap counts over. */
export const SANDBOX_FUNDING_WINDOW_MS = 30 * 86_400_000;

async function upsertSubscription(tx: Tx, input: {
  userId: string;
  facts: AppleTransactionFacts;
  existing: SubscriptionStateOnFile & { lastSignedMs: number | null } | null;
  fromNotification: boolean;
  notificationStatus: number | null;
  renewal: VerifiedRenewalInfo | null;
  now: Date;
}): Promise<void> {
  const { facts, now } = input;
  const signedAt = facts.signedDateMs === null ? null : new Date(facts.signedDateMs);
  const expiresDateMs = facts.expiresDateMs ?? facts.purchaseDateMs;
  const incomingStatus = appleSubscriptionStatus({ facts, notificationStatus: input.notificationStatus, nowMs: now.getTime() });
  const incomingExpiresMs = entitlementEndMs({ expiresDateMs, gracePeriodExpiresMs: input.renewal?.gracePeriodExpiresMs ?? null, status: incomingStatus });
  if (!input.existing) {
    await tx.insert(appStoreSubscriptions).values({
      userId: input.userId,
      originalTransactionId: facts.originalTransactionId,
      latestTransactionId: facts.transactionId,
      productId: facts.productId,
      status: incomingStatus,
      environment: facts.environment,
      currentPeriodStart: new Date(facts.purchaseDateMs),
      expiresAt: new Date(incomingExpiresMs),
      autoRenew: input.renewal?.autoRenew ?? true,
      lastSignedAt: signedAt,
    }).onConflictDoNothing({ target: appStoreSubscriptions.originalTransactionId });
    return;
  }
  // Apple's signing order decides: an older payload (a replayed device post, a delayed
  // notification retry) changes nothing about the subscription.
  if (isStalePayload({ lastSignedMs: input.existing.lastSignedMs, signedMs: facts.signedDateMs })) return;
  const next = nextSubscriptionState(input.existing, {
    status: incomingStatus,
    expiresAtMs: incomingExpiresMs,
    purchaseMs: facts.purchaseDateMs,
    fromNotification: input.fromNotification,
  });
  await tx.update(appStoreSubscriptions).set({
    ...(next.apply ? {
      latestTransactionId: facts.transactionId,
      productId: facts.productId,
      status: next.status,
      environment: facts.environment,
      currentPeriodStart: new Date(facts.purchaseDateMs),
      expiresAt: new Date(next.expiresAtMs),
    } : {}),
    // Renewal preferences describe the subscription, whichever period the payload is about.
    ...(input.renewal ? { autoRenew: input.renewal.autoRenew } : {}),
    lastSignedAt: signedAt,
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
  const fromNotification = input.source === 'notification';

  return db.transaction(async (tx): Promise<AppleApplyResult> => {
    // Shared lock order with the Stripe webhook and the tier reconciler: user, then mirror.
    const [user] = await tx.select({ id: users.id, subscriptionTier: users.subscriptionTier }).from(users).where(eq(users.id, userId)).for('update');
    if (!user) return { result: 'refused', reason: 'unknown_user' };

    const [owned] = await tx
      .select({
        userId: appStoreSubscriptions.userId,
        status: appStoreSubscriptions.status,
        expiresAt: appStoreSubscriptions.expiresAt,
        currentPeriodStart: appStoreSubscriptions.currentPeriodStart,
        lastSignedAt: appStoreSubscriptions.lastSignedAt,
      })
      .from(appStoreSubscriptions)
      .where(eq(appStoreSubscriptions.originalTransactionId, facts.originalTransactionId))
      .for('update');
    if (owned && owned.userId !== userId) return { result: 'refused', reason: 'owned_by_another_user' };

    const plan = planAppleTransaction(facts, {
      bundleId: input.config.bundleId,
      allowSandbox: input.config.allowSandbox,
      expectedAccountToken: await accountTokenForUser(tx, userId),
      ownershipEstablished: owned?.userId === userId,
      // Only the signed-in buyer posting from their device may claim an unowned token-less
      // subscription; a notification can never assign one to anybody.
      claimable: !fromNotification && !owned,
    });
    if (plan.kind === 'refuse') return { result: 'refused', reason: plan.reason };

    const product = appleProduct(facts.productId);
    const productKind = product?.kind === 'subscription' ? 'subscription' : 'consumable';
    const recorded = await readTransaction(tx, userId, facts, productKind);
    const revocation = recorded.stale
      ? ({ kind: 'none' } as const)
      : reconcileRevocation({
          storedRevokedAtMs: recorded.storedRevokedAtMs,
          factsRevokedAtMs: facts.revocationDateMs,
          isRefundReversal: fromNotification && input.notificationType === 'REFUND_REVERSED',
        });
    // The revocation state after this payload: credit is never granted while it is revoked.
    const revokedAfter = revocation.kind === 'revoke' ? revocation.revokedAtMs
      : revocation.kind === 'reinstate' ? null
      : recorded.storedRevokedAtMs;

    if (productKind === 'subscription') {
      await upsertSubscription(tx, {
        userId,
        facts,
        existing: owned ? {
          status: owned.status,
          expiresAtMs: owned.expiresAt.getTime(),
          latestPurchaseMs: owned.currentPeriodStart.getTime(),
          lastSignedMs: owned.lastSignedAt?.getTime() ?? null,
        } : null,
        fromNotification,
        notificationStatus: input.notificationStatus ?? null,
        renewal: input.renewal ?? null,
        now,
      });
    }

    const mayFund = async (): Promise<boolean> => recorded.funded || sandboxFundingAllowed({
      environment: facts.environment,
      fundedSandboxRecently: facts.environment === 'Sandbox' ? await recentSandboxFundings(tx, userId, now) : 0,
      maxSandboxFundings: input.config.sandboxMaxFundings,
      allowlisted: input.config.sandboxAllowlist.includes(userId),
    });

    let applied = false;
    let funded = recorded.funded;
    switch (plan.kind) {
      case 'subscription_period':
      case 'consumable': {
        const grantCents = plan.kind === 'consumable' ? plan.topupCents : plan.allowanceCents;
        if (revokedAfter !== null || grantCents <= 0) break;
        if (!(await mayFund())) {
          loggers.api.warn('App Store Sandbox purchase not funded: Sandbox funding cap reached', { userId, transactionId: facts.transactionId });
          break;
        }
        const fund = (fundingRef: string, cents: number) => plan.kind === 'consumable'
          ? fundTopup(tx, { userId, fundingRef, topupCents: cents })
          : fundMonthlyGrant(tx, {
              userId,
              fundingRef,
              allowanceCents: cents,
              paidCents: plan.paidCents,
              // A re-grant after a reversed refund must not move the root's period clock.
              periodStart: fundingRef === appleGrantRef(facts.transactionId) ? new Date(plan.periodStartMs) : null,
              periodEnd: fundingRef === appleGrantRef(facts.transactionId) ? new Date(plan.periodEndMs) : null,
            });
        applied = (await fund(appleGrantRef(facts.transactionId), grantCents)).applied;
        if (revocation.kind === 'reinstate' && await ledgerRefExists(tx, appleRefundRef(facts.transactionId, revocation.revokedAtMs))) {
          // Re-grant what the purchase was originally credited, not today's catalog figure.
          const originalCents = (await ledgerAmountCents(tx, appleGrantRef(facts.transactionId))) ?? grantCents;
          applied = (await fund(appleReinstateRef(facts.transactionId, revocation.revokedAtMs), originalCents)).applied || applied;
        }
        funded = funded || applied;
        break;
      }
      case 'revoke_subscription':
      case 'revoke_consumable': {
        // Only what this transaction actually granted — the amount its ledger row recorded —
        // is clawed back: a refund for a transaction we never funded (or a $0 period) takes nothing.
        const grantedCents = revocation.kind === 'revoke' ? await ledgerAmountCents(tx, appleGrantRef(facts.transactionId)) : null;
        if (revocation.kind === 'revoke' && grantedCents !== null && grantedCents > 0) {
          applied = await clawBack(tx, {
            userId,
            fundingRef: appleRefundRef(facts.transactionId, revocation.revokedAtMs),
            cents: grantedCents,
            first: plan.kind === 'revoke_subscription' ? 'monthly' : 'topup',
          });
        }
        break;
      }
    }

    if (!recorded.isNew && !recorded.stale) {
      await tx.update(appStoreTransactions).set({
        revokedAt: revokedAfter === null ? null : new Date(revokedAfter),
        lastSignedAt: facts.signedDateMs === null ? null : new Date(facts.signedDateMs),
        funded,
      }).where(eq(appStoreTransactions.transactionId, facts.transactionId));
    } else if (recorded.isNew && (funded || revokedAfter !== null)) {
      await tx.update(appStoreTransactions).set({
        revokedAt: revokedAfter === null ? null : new Date(revokedAfter),
        funded,
      }).where(eq(appStoreTransactions.transactionId, facts.transactionId));
    }

    const subscriptionTier = await writeMergedTier(tx, userId, input.priceTier, now, user.subscriptionTier);
    const kind = plan.kind === 'revoke_subscription' || plan.kind === 'revoke_consumable' ? 'revoked' : productKind;
    return { result: applied || recorded.isNew ? 'applied' : 'duplicate', kind, subscriptionTier };
  });
}

export type AppleNotificationResult =
  | Extract<AppleApplyResult, { result: 'refused' }>
  | (Extract<AppleApplyResult, { result: 'applied' | 'duplicate' }> & { userId: string })
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

  const applied = await applyAppleTransaction({
    userId,
    decoded: notification.transaction,
    source: 'notification',
    notificationType: notification.type,
    notificationStatus: notification.status,
    renewal: notification.renewal,
    priceTier: input.priceTier,
    config: input.config,
    now: input.now,
  });
  return applied.result === 'refused' ? applied : { ...applied, userId };
}
