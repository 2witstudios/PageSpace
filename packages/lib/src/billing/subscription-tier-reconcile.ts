/**
 * Periodic reconciler for the users.subscriptionTier cache — the counterpart
 * of the credit balance's computeBalanceDrift sweep, for subscription tiers.
 *
 * The cache is written only by the Stripe webhook, so a missed/failed webhook
 * leaves it stale indefinitely. This sweep walks every user, re-derives the
 * tier from their subscriptions rows (Stripe's local mirror — no Stripe
 * calls), and repairs repairable drift in place with logging + audit-friendly
 * details. Two drift shapes are reported but never auto-repaired — see
 * computeTierDrift:
 *   - an indeterminate derivation (an entitled row on an unmapped legacy price)
 *   - a non-free stored tier with ZERO subscriptions rows at all — the exact
 *     population `scripts/sync-legacy-subscriptions.ts` used to migrate.
 *     Auto-repairing this would silently revoke a paying customer's
 *     entitlements instead of completing that migration. A canceled/expired
 *     subscription still leaves a row and derives to 'free' normally — this
 *     guard only withholds the true zero-rows case.
 *
 * Replaces the one-shot repair scripts this drift class used to require
 * for the entitled-row derivation itself (scripts/sync-legacy-subscriptions.ts);
 * the zero-rows case it also handled still needs a human to complete (create
 * the missing subscription/gift), which is why that case is flagged, not fixed.
 */

import { db } from '@pagespace/db/db';
import { and, eq, gt, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { loggers } from '../logging/logger-config';
import {
  ENTITLED_SUBSCRIPTION_STATUSES,
  computeTierDrift,
  deriveTierFromSubscriptions,
  type PriceTierResolver,
  type SubscriptionRowLike,
} from './subscription-tier-sync';

/** Subscription rows include a non-entitled status too, so we can tell "no record at all" apart from "canceled". */
type ReconcileSubscriptionRow = SubscriptionRowLike & { userId: string };

export interface TierDriftDetail {
  userId: string;
  storedTier: string;
  expectedTier: string;
  repaired: boolean;
  /** True when the derivation saw an entitled row with an unmapped price. */
  indeterminate: boolean;
  /** False means a non-free stored tier with zero subscriptions rows — the unmigrated-legacy-user case. */
  hasAnySubscriptionRecord: boolean;
}

export interface TierReconcileResult {
  scanned: number;
  drifted: number;
  repaired: number;
  /** Drifts flagged for a human because the derivation was indeterminate. */
  flaggedOnly: number;
  details: TierDriftDetail[];
}

const BATCH_SIZE = 500;
/** Cap the per-run detail payload so a mass-drift event can't blow up logs/response. */
const MAX_DETAILS = 100;

/**
 * Sweep all users, compare the cached tier against the derived tier, and (when
 * `repair` is true) write the derived value back for repairable drift. The
 * repair UPDATE is guarded on the observed stored value so a concurrent
 * webhook write always wins over the sweep.
 */
export async function reconcileSubscriptionTiers(options: {
  priceTier: PriceTierResolver;
  repair?: boolean;
}): Promise<TierReconcileResult> {
  const repair = options.repair ?? true;
  const result: TierReconcileResult = { scanned: 0, drifted: 0, repaired: 0, flaggedOnly: 0, details: [] };

  let cursor = '';
  for (;;) {
    const batch = await db
      .select({ id: users.id, subscriptionTier: users.subscriptionTier })
      .from(users)
      .where(gt(users.id, cursor))
      .orderBy(users.id)
      .limit(BATCH_SIZE);
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;
    result.scanned += batch.length;

    // ALL statuses, not just entitled: a user with zero rows whatsoever is a
    // different (non-repairable) case from a user whose only row is
    // canceled — see computeTierDrift's unmigrated-legacy-user guard.
    const subRows: ReconcileSubscriptionRow[] = await db
      .select({
        userId: subscriptions.userId,
        status: subscriptions.status,
        stripePriceId: subscriptions.stripePriceId,
      })
      .from(subscriptions)
      .where(inArray(subscriptions.userId, batch.map((u) => u.id)));

    const rowsByUser = new Map<string, ReconcileSubscriptionRow[]>();
    for (const row of subRows) {
      const list = rowsByUser.get(row.userId) ?? [];
      list.push(row);
      rowsByUser.set(row.userId, list);
    }

    for (const user of batch) {
      const allRows = rowsByUser.get(user.id) ?? [];
      const entitledRows = allRows.filter((row) => ENTITLED_SUBSCRIPTION_STATUSES.includes(row.status));
      const derived = deriveTierFromSubscriptions(entitledRows, options.priceTier);
      const hasAnySubscriptionRecord = allRows.length > 0;
      const drift = computeTierDrift({ storedTier: user.subscriptionTier, derived, hasAnySubscriptionRecord });
      if (!drift.drifted) continue;

      result.drifted += 1;
      let repaired = false;
      if (repair && drift.repairable) {
        // CAS on the stored value: if the webhook rewrote the tier since we
        // read it, this matches zero rows and the sweep defers to the webhook.
        const updated = await db
          .update(users)
          .set({ subscriptionTier: drift.expectedTier, updatedAt: new Date() })
          .where(and(eq(users.id, user.id), eq(users.subscriptionTier, user.subscriptionTier)))
          .returning({ id: users.id });
        repaired = updated.length > 0;
        result.repaired += repaired ? 1 : 0;
      }
      if (!repaired && !drift.repairable) result.flaggedOnly += 1;

      loggers.system.warn('Subscription tier drift detected', {
        userId: user.id,
        storedTier: user.subscriptionTier,
        expectedTier: drift.expectedTier,
        indeterminate: derived.indeterminate,
        hasAnySubscriptionRecord,
        repaired,
      });
      if (result.details.length < MAX_DETAILS) {
        result.details.push({
          userId: user.id,
          storedTier: user.subscriptionTier,
          expectedTier: drift.expectedTier,
          repaired,
          indeterminate: derived.indeterminate,
          hasAnySubscriptionRecord,
        });
      }
    }
  }

  return result;
}
