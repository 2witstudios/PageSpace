/**
 * Periodic reconciler for the users.subscriptionTier cache — the counterpart
 * of the wallet balance-drift sweep (wallet-reconcile), for subscription tiers.
 *
 * The cache is written by the Stripe webhook and the App Store paths, so a missed/failed
 * event leaves it stale indefinitely — and an App Store plan also lapses on its own once
 * its paid period ends. This sweep walks every user, re-derives the tier from their
 * subscriptions rows (Stripe's local mirror — no Stripe calls) merged with their App
 * Store subscriptions (apple-entitlement), and repairs repairable drift in place with logging + audit-friendly
 * details. Unknown prices and absent subscription rows confer no paid entitlement;
 * the cache is repaired to the verified result even when diagnosis is indeterminate.
 */

import { db } from '@pagespace/db/db';
import { and, eq, gt, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { loggers } from '../logging/logger-config';
import { isBillingEnabled } from '../deployment-mode';
import {
  ENTITLED_SUBSCRIPTION_STATUSES,
  computeTierDrift,
  deriveTierFromSubscriptions,
  type PriceTierResolver,
  type SubscriptionRowLike,
} from './subscription-tier-sync';
import { combineTiers } from './apple/apple-core';
import { appleEntitledTier, appleEntitledTiers } from './apple/apple-entitlement';

/** Subscription rows include a non-entitled status too, so we can tell "no record at all" apart from "canceled". */
type ReconcileSubscriptionRow = SubscriptionRowLike & { userId: string };

export interface TierDriftDetail {
  userId: string;
  storedTier: string;
  expectedTier: string;
  repaired: boolean;
  /** True when the derivation saw an entitled row with an unmapped price. */
  indeterminate: boolean;
  /** Whether the user has any mirrored subscription, including inactive ones. */
  hasAnySubscriptionRecord: boolean;
}

export interface TierReconcileResult {
  scanned: number;
  drifted: number;
  repaired: number;
  /** Drifts not written because repair was disabled or a concurrent write won. */
  flaggedOnly: number;
  details: TierDriftDetail[];
}

const BATCH_SIZE = 500;
/** Cap the per-run detail payload so a mass-drift event can't blow up logs/response. */
const MAX_DETAILS = 100;

/**
 * Sweep all users, compare the cached tier against the derived tier, and (when
 * `repair` is true) write the derived value back for repairable drift. The
 * repair locks the user and re-reads subscription evidence. Webhooks atomically
 * update their subscription mirror and this same user, so a stale batch cannot
 * overwrite a completed webhook or win over a webhook waiting on the user lock.
 */
export async function reconcileSubscriptionTiers(options: {
  priceTier: PriceTierResolver;
  repair?: boolean;
  /**
   * Restrict the sweep to these users. The cron omits it and walks the whole
   * table; tests in a shared database pass their fixtures so a sweep cannot
   * "repair" users that belong to concurrently running suites.
   */
  userIds?: string[];
}): Promise<TierReconcileResult> {
  const repair = options.repair ?? true;
  const result: TierReconcileResult = { scanned: 0, drifted: 0, repaired: 0, flaggedOnly: 0, details: [] };
  if (!isBillingEnabled()) return result;

  let cursor = '';
  for (;;) {
    const batch = await db
      .select({ id: users.id, subscriptionTier: users.subscriptionTier })
      .from(users)
      .where(options.userIds
        ? and(inArray(users.id, options.userIds), gt(users.id, cursor))
        : gt(users.id, cursor))
      .orderBy(users.id)
      .limit(BATCH_SIZE);
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;
    result.scanned += batch.length;

    // Keep all rows for diagnostics; only entitled configured prices establish access.
    const subRows: ReconcileSubscriptionRow[] = await db
      .select({
        userId: subscriptions.userId,
        status: subscriptions.status,
        stripePriceId: subscriptions.stripePriceId,
      })
      .from(subscriptions)
      .where(inArray(subscriptions.userId, batch.map((u) => u.id)));

    // The App Store half of each user's plan: a tier is one fact whichever store sold it.
    const now = new Date();
    const appleTiers = await appleEntitledTiers(db, batch.map((u) => u.id), now);

    const rowsByUser = new Map<string, ReconcileSubscriptionRow[]>();
    for (const row of subRows) {
      const list = rowsByUser.get(row.userId) ?? [];
      list.push(row);
      rowsByUser.set(row.userId, list);
    }

    // Compute drift for the whole batch first (cheap, synchronous) so the
    // independent per-user CAS repairs below can run concurrently instead of
    // one DB round-trip at a time.
    const driftedUsers = batch
      .map((user) => {
        const allRows = rowsByUser.get(user.id) ?? [];
        const entitledRows = allRows.filter((row) => ENTITLED_SUBSCRIPTION_STATUSES.includes(row.status));
        const stripeDerived = deriveTierFromSubscriptions(entitledRows, options.priceTier);
        const derived = { ...stripeDerived, tier: combineTiers(stripeDerived.tier, appleTiers.get(user.id) ?? 'free') };
        const hasAnySubscriptionRecord = allRows.length > 0 || appleTiers.has(user.id);
        const drift = computeTierDrift({ storedTier: user.subscriptionTier, derived });
        if (!drift.drifted) return null;
        return {
          user,
          drift,
          hasAnySubscriptionRecord,
          indeterminate: derived.indeterminate,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    result.drifted += driftedUsers.length;

    // Batch reads are diagnostics only; authorize every repair from fresh evidence
    // while holding the user lock shared with webhook transactions.
    const repairedFlags = await Promise.all(
      driftedUsers.map(async ({ user, drift }) => {
        if (!repair) return false;
        return db.transaction(async (tx) => {
          const [current] = await tx.select({ tier: users.subscriptionTier }).from(users)
            .where(eq(users.id, user.id)).for('update');
          if (!current || current.tier !== user.subscriptionTier) return false;
          const currentRows = await tx.select({ status: subscriptions.status, stripePriceId: subscriptions.stripePriceId })
            .from(subscriptions).where(eq(subscriptions.userId, user.id));
          const stripeDerived = deriveTierFromSubscriptions(
            currentRows.filter((row) => ENTITLED_SUBSCRIPTION_STATUSES.includes(row.status)),
            options.priceTier,
          );
          const derived = { ...stripeDerived, tier: combineTiers(stripeDerived.tier, await appleEntitledTier(tx, user.id, now)) };
          const freshDrift = computeTierDrift({ storedTier: current.tier, derived });
          if (!freshDrift.drifted || freshDrift.expectedTier !== drift.expectedTier) return false;
          await tx.update(users).set({ subscriptionTier: freshDrift.expectedTier, updatedAt: new Date() })
            .where(eq(users.id, user.id));
          return true;
        });
      }),
    );

    driftedUsers.forEach(({ user, drift, hasAnySubscriptionRecord, indeterminate }, i) => {
      const repaired = repairedFlags[i];
      if (!repaired) result.flaggedOnly += 1;
      if (repaired) result.repaired += 1;

      loggers.system.warn('Subscription tier drift detected', {
        userId: user.id,
        storedTier: user.subscriptionTier,
        expectedTier: drift.expectedTier,
        indeterminate,
        hasAnySubscriptionRecord,
        repaired,
      });
      if (result.details.length < MAX_DETAILS) {
        result.details.push({
          userId: user.id,
          storedTier: user.subscriptionTier,
          expectedTier: drift.expectedTier,
          repaired,
          indeterminate,
          hasAnySubscriptionRecord,
        });
      }
    });
  }

  return result;
}
