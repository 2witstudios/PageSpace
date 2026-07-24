/**
 * Single derivation path for the denormalized `users.subscriptionTier` column.
 *
 * `users.subscriptionTier` is a CACHE of the `subscriptions` table (which is
 * itself a mirror of Stripe, maintained by the Stripe webhook). ~40 read sites
 * gate features off the cached column; this module is the ONE place that
 * decides what value belongs there:
 *
 *   - pure core: {@link deriveTierFromSubscriptions} resolves a tier from a
 *     user's subscription rows; {@link computeTierDrift} compares it against
 *     the cached column (modeled on computeBalanceDrift in credit-core). The
 *     Stripe webhook (apps/web .../stripe/webhook/route.ts) calls
 *     deriveTierFromSubscriptions with the single row from the event it just
 *     received and writes the result through — the same function the
 *     reconciler below uses across the whole table, so there is exactly one
 *     rule for "what tier does this subscription state imply".
 *   - reconciler shell: subscription-tier-reconcile.ts sweeps the whole users
 *     table periodically (cron) to detect and repair drift from missed/failed
 *     webhooks (including the multi-subscription case a single webhook event
 *     can't see) — the failure class the retired one-shot repair scripts
 *     (sync-legacy-subscriptions.ts) existed for.
 */

import { tierRank, toSubscriptionTier, type SubscriptionTier } from './subscription-tiers';

/** Subscription statuses that entitle the user to their paid tier (webhook parity). */
export const ENTITLED_SUBSCRIPTION_STATUSES: readonly string[] = ['active', 'trialing'];

/** Maps a Stripe price id to its tier; returns 'free' for unmapped prices. */
export type PriceTierResolver = (stripePriceId: string) => SubscriptionTier;

export interface SubscriptionRowLike {
  status: string;
  stripePriceId: string;
}

export interface DerivedTier {
  tier: SubscriptionTier;
  /**
   * True when at least one ENTITLED row's price could not be mapped to a tier
   * (resolver returned 'free' — no free Stripe price exists, so 'free' from an
   * entitled row always means "unmapped", e.g. a legacy price id). The derived
   * tier is then a lower bound, not the truth: callers must not auto-repair
   * downward from it.
   */
  indeterminate: boolean;
}

/**
 * Resolve the tier a user's subscription rows entitle them to: the
 * highest-ranked tier across entitled (active/trialing) rows, or 'free' when
 * none exist. Pure.
 */
export function deriveTierFromSubscriptions(
  rows: readonly SubscriptionRowLike[],
  priceTier: PriceTierResolver,
): DerivedTier {
  let tier: SubscriptionTier = 'free';
  let indeterminate = false;
  for (const row of rows) {
    if (!ENTITLED_SUBSCRIPTION_STATUSES.includes(row.status)) continue;
    const rowTier = priceTier(row.stripePriceId);
    if (rowTier === 'free') {
      indeterminate = true;
      continue;
    }
    if (tierRank(rowTier) > tierRank(tier)) tier = rowTier;
  }
  return { tier, indeterminate };
}

export interface TierDriftResult {
  /** Stored value coerced to the vocabulary ('free' for unknown text). */
  storedTier: SubscriptionTier;
  expectedTier: SubscriptionTier;
  drifted: boolean;
  /** Drift the reconciler may write back; false when the derivation is indeterminate. */
  repairable: boolean;
}

/**
 * Compare the cached users.subscriptionTier against what the subscriptions
 * rows imply. Pure; modeled on computeBalanceDrift. Two cases are flagged for
 * a human and never auto-repaired:
 *
 *   - an indeterminate derivation (an entitled row on an unmapped legacy
 *     price) — repairing would downgrade a legacy paid user whose price id
 *     predates the current price map.
 *   - a non-free stored tier with NO subscription record at all
 *     (`hasAnySubscriptionRecord: false`) — this is exactly the population
 *     `scripts/sync-legacy-subscriptions.ts` existed to migrate: a paid tier
 *     set before the subscriptions table (or a gift) was ever backed by a
 *     real Stripe subscription row. A canceled/expired subscription still
 *     LEAVES A ROW (status != active/trialing), which correctly derives to
 *     'free' and IS repairable — only the true zero-rows case is ambiguous
 *     enough to withhold from auto-repair.
 */
export function computeTierDrift(input: {
  storedTier: string;
  derived: DerivedTier;
  /** Whether the user has ANY subscriptions row, of any status. */
  hasAnySubscriptionRecord: boolean;
}): TierDriftResult {
  const storedTier = toSubscriptionTier(input.storedTier);
  const expectedTier = input.derived.tier;
  const drifted = storedTier !== expectedTier;
  const unmigratedLegacyPaidUser = storedTier !== 'free' && !input.hasAnySubscriptionRecord;
  return {
    storedTier,
    expectedTier,
    drifted,
    repairable: drifted && !input.derived.indeterminate && !unmigratedLegacyPaidUser,
  };
}
