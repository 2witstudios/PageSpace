/**
 * apple-entitlement — reads of the App Store mirror that the rest of billing needs, so a
 * plan sold by Apple counts everywhere a plan sold by Stripe does:
 *   - the tier the user's App Store subscriptions entitle (merged with the Stripe-derived
 *     tier by every writer of users.subscriptionTier — combineTiers in apple-core);
 *   - whether the user has an App Store subscription that can still renew, so the hourly
 *     comped-root sweep never grants a list-price allowance on top of Apple's renewal
 *     grant (wallet-funding-shell rollDuePersonalRoots).
 */

import { db } from '@pagespace/db/db';
import { and, eq, gt, inArray } from '@pagespace/db/operators';
import { appStoreSubscriptions } from '@pagespace/db/schema/app-store';
import type { SubscriptionTier } from '../subscription-tiers';
import { deriveTierFromAppleSubscriptions } from './apple-core';

/** A db or an open transaction. */
type Executor = Pick<typeof db, 'select'>;

/**
 * App Store statuses under which Apple may still charge and send a renewal: the comped
 * sweep must leave these accounts to that renewal.
 */
export const APPLE_RENEWAL_CAPABLE_STATUSES = ['active', 'billing_retry', 'grace_period'] as const;

/** The tier the user's App Store subscriptions entitle at `now`. */
export async function appleEntitledTier(executor: Executor, userId: string, now: Date): Promise<SubscriptionTier> {
  const rows = await executor
    .select({ status: appStoreSubscriptions.status, productId: appStoreSubscriptions.productId, expiresAt: appStoreSubscriptions.expiresAt })
    .from(appStoreSubscriptions)
    .where(eq(appStoreSubscriptions.userId, userId));
  return deriveTierFromAppleSubscriptions(
    rows.map((r) => ({ status: r.status, productId: r.productId, expiresAtMs: r.expiresAt.getTime() })),
    now.getTime(),
  );
}

/** {@link appleEntitledTier} for a batch of users (the tier reconciler's page). */
export async function appleEntitledTiers(executor: Executor, userIds: readonly string[], now: Date): Promise<Map<string, SubscriptionTier>> {
  const tiers = new Map<string, SubscriptionTier>();
  if (userIds.length === 0) return tiers;
  const rows = await executor
    .select({
      userId: appStoreSubscriptions.userId,
      status: appStoreSubscriptions.status,
      productId: appStoreSubscriptions.productId,
      expiresAt: appStoreSubscriptions.expiresAt,
    })
    .from(appStoreSubscriptions)
    .where(inArray(appStoreSubscriptions.userId, [...userIds]));
  const byUser = new Map<string, Array<{ status: string; productId: string; expiresAtMs: number }>>();
  for (const row of rows) {
    const list = byUser.get(row.userId) ?? [];
    list.push({ status: row.status, productId: row.productId, expiresAtMs: row.expiresAt.getTime() });
    byUser.set(row.userId, list);
  }
  for (const [userId, list] of byUser) tiers.set(userId, deriveTierFromAppleSubscriptions(list, now.getTime()));
  return tiers;
}

/** Whether Apple may still renew one of the user's subscriptions (so it, not the sweep, grants). */
export async function hasRenewableAppleSubscription(executor: Executor, userId: string, now: Date): Promise<boolean> {
  const rows = await executor
    .select({ id: appStoreSubscriptions.id })
    .from(appStoreSubscriptions)
    .where(and(
      eq(appStoreSubscriptions.userId, userId),
      inArray(appStoreSubscriptions.status, [...APPLE_RENEWAL_CAPABLE_STATUSES]),
      // A long-lapsed row stuck in billing retry (Apple retries for up to 60 days) is no
      // longer a renewal source.
      gt(appStoreSubscriptions.expiresAt, new Date(now.getTime() - APPLE_BILLING_RETRY_WINDOW_MS)),
    ))
    .limit(1);
  return rows.length > 0;
}

/** Apple retries a failed renewal for up to 60 days. */
export const APPLE_BILLING_RETRY_WINDOW_MS = 60 * 86_400_000;

export interface AppStoreSubscriptionView {
  status: string;
  productId: string;
  expiresAt: Date;
  autoRenew: boolean;
  environment: string;
}

/** The user's most recent App Store subscription, for the status route. */
export async function latestAppleSubscription(executor: Executor, userId: string): Promise<AppStoreSubscriptionView | null> {
  const rows = await executor
    .select({
      status: appStoreSubscriptions.status,
      productId: appStoreSubscriptions.productId,
      expiresAt: appStoreSubscriptions.expiresAt,
      autoRenew: appStoreSubscriptions.autoRenew,
      environment: appStoreSubscriptions.environment,
    })
    .from(appStoreSubscriptions)
    .where(eq(appStoreSubscriptions.userId, userId));
  if (rows.length === 0) return null;
  return rows.reduce((latest, row) => (row.expiresAt > latest.expiresAt ? row : latest));
}
