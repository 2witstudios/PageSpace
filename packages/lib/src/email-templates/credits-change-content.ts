/**
 * credits-change-content — derives the per-tier copy for the metered-AI-credits
 * announcement email straight from the billing source of truth
 * (`../billing/credit-pricing`). Keeping this derivation in one place means the
 * announcement email, the broadcast script, and the tests all read the SAME
 * numbers — the dollar figures can never drift from what the gate actually grants.
 *
 * This module is pure (no I/O, no React) so it is trivially unit-testable and
 * safe to import from both the template and the broadcast script.
 */

import {
  TIER_MONTHLY_ALLOWANCE_CENTS,
  CREDIT_PACKS,
  type CreditPack,
} from '../billing/credit-pricing';
import type { SubscriptionTier } from '../services/subscription-utils';

/**
 * Format whole cents as a customer-facing USD string. Whole-dollar amounts drop
 * the trailing ".00" for cleaner copy ("$5"); sub-dollar precision is preserved
 * ("$15.50") so a tuned env override never renders a misleading rounded figure.
 */
export function formatCents(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** Human-readable label for each subscription tier. */
const TIER_LABELS: Record<SubscriptionTier, string> = {
  free: 'Free',
  pro: 'Pro',
  founder: 'Founder',
  business: 'Business',
};

/**
 * Custom top-up amount bounds, in cents. Mirrors the in-app custom top-up
 * limits ($5–$500) so the announcement copy can't promise a range the
 * checkout won't accept. Kept here so the email, marketing copy, and tests
 * read one source.
 */
export const TOPUP_MIN_CENTS = 500;
export const TOPUP_MAX_CENTS = 50_000;

export interface TopupPackSummary {
  /** Stable pack SKU id (matches `CreditPack.id`). */
  id: string;
  /** Marketing label from the pack definition, e.g. "$10 credits". */
  label: string;
  /** Formatted credit value the pack adds, e.g. "$10". */
  amountLabel: string;
}

export interface TierCreditSummary {
  tier: SubscriptionTier;
  /** Display name for the tier, e.g. "Pro". */
  tierLabel: string;
  /** Raw monthly allowance in cents, straight from credit-pricing. */
  monthlyAllowanceCents: number;
  /** Formatted monthly allowance, e.g. "$15". */
  monthlyAllowanceLabel: string;
  /** Buy-more top-up packs available to every tier. */
  topupPacks: TopupPackSummary[];
  /** Whether this tier unlocks frontier model choice (paid tiers do). */
  unlocksPremiumModels: boolean;
  /** Lower bound of a custom top-up, e.g. "$5". */
  topupMinLabel: string;
  /** Upper bound of a custom top-up, e.g. "$500". */
  topupMaxLabel: string;
}

/**
 * Coerce an arbitrary stored `users.subscriptionTier` string into a known tier.
 * Unknown/legacy values fall back to `free` so the email always renders a valid
 * allowance rather than throwing on a stray value.
 */
export function normalizeTier(raw: string | null | undefined): SubscriptionTier {
  if (raw === 'pro' || raw === 'founder' || raw === 'business') return raw;
  return 'free';
}

/** Build the announcement copy data for a single tier from credit-pricing. */
export function getTierCreditSummary(tier: SubscriptionTier): TierCreditSummary {
  const monthlyAllowanceCents = TIER_MONTHLY_ALLOWANCE_CENTS[tier];

  const topupPacks: TopupPackSummary[] = Object.values(CREDIT_PACKS).map(
    (pack: CreditPack) => ({
      id: pack.id,
      label: pack.label,
      amountLabel: formatCents(pack.cents),
    }),
  );

  return {
    tier,
    tierLabel: TIER_LABELS[tier],
    monthlyAllowanceCents,
    monthlyAllowanceLabel: formatCents(monthlyAllowanceCents),
    topupPacks,
    unlocksPremiumModels: tier !== 'free',
    topupMinLabel: formatCents(TOPUP_MIN_CENTS),
    topupMaxLabel: formatCents(TOPUP_MAX_CENTS),
  };
}
