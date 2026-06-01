/**
 * credit-pricing — configuration for prepaid AI-credits billing.
 *
 * These constants/tables are passed INTO the pure functions in credit-core; the
 * core never imports this module. Env overrides let the founder tune economics
 * without a code change. All monetary values are whole cents of customer-facing
 * credit value. Placeholder defaults — final numbers TBD at kickoff.
 */

import type { SubscriptionTier } from '../services/subscription-utils';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Markup applied to real provider cost, in basis points. 15000 = 1.5×. */
export const MARKUP_BPS = envInt('CREDIT_MARKUP_BPS', 15000);

/**
 * Monthly credit allowance granted on each subscription renewal, per tier.
 * Resets every period (use-it-or-lose-it).
 */
export const TIER_MONTHLY_ALLOWANCE_CENTS: Record<SubscriptionTier, number> = {
  // Free: generous $5/mo of credit value, but the free-tier-only premium gate
  // (requiresProSubscription) confines it to cheaper "standard" models, so the
  // real provider cost behind that $5 stays low.
  free: envInt('CREDIT_ALLOWANCE_FREE_CENTS', 500),
  pro: envInt('CREDIT_ALLOWANCE_PRO_CENTS', 1500),
  founder: envInt('CREDIT_ALLOWANCE_FOUNDER_CENTS', 5000),
  business: envInt('CREDIT_ALLOWANCE_BUSINESS_CENTS', 10000),
};

/**
 * Block AI when spendable credits are at or below this floor. Bounds the single
 * in-flight call that can overshoot zero (cost is only known post-stream), so we
 * never meaningfully front unpaid usage.
 */
export const RESERVE_FLOOR_CENTS = envInt('CREDIT_RESERVE_FLOOR_CENTS', 0);

export interface CreditPack {
  /** Stable SKU id, also stored in Stripe price metadata. */
  id: string;
  /** Credit value added to the top-up bucket, in cents. */
  cents: number;
  /** Human label for the dashboard CTA. */
  label: string;
}

/** One-time top-up packs offered for purchase. */
export const CREDIT_PACKS: Record<string, CreditPack> = {
  pack_10: { id: 'pack_10', cents: 1000, label: '$10 credits' },
  pack_25: { id: 'pack_25', cents: 2500, label: '$25 credits' },
  pack_50: { id: 'pack_50', cents: 5000, label: '$50 credits' },
};

export function getCreditPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS[id];
}
