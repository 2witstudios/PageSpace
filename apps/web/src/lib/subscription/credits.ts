/**
 * In-app AI-credit copy helpers — the single source of truth for any credit/pricing
 * number shown inside `apps/web` (plan cards, settings, the balance widget).
 *
 * Every dollar figure is derived from the canonical billing constants in
 * `@pagespace/lib/billing/credit-pricing` (`TIER_MONTHLY_ALLOWANCE_CENTS` and
 * `CREDIT_PACKS`) so in-app pricing copy can never drift from what the app meters.
 * Mirrors `apps/marketing/src/lib/credits.ts` for the marketing surface. Do NOT
 * hardcode tier dollar amounts or top-up pack values elsewhere in `apps/web` —
 * import from this module instead.
 *
 * NOTE: env overrides in credit-pricing read `process.env`, which is inlined as the
 * compile-time default in the client bundle. These display values therefore reflect
 * the built-in defaults on the client, which is correct for marketing/plan copy; the
 * authoritative live balance always comes from `GET /api/credits`.
 */
import {
  TIER_MONTHLY_ALLOWANCE_CENTS,
  TIER_ALLOWANCE_REFILLS,
  CREDIT_PACKS,
  CREDIT_TOPUP_MIN_CENTS,
  CREDIT_TOPUP_MAX_CENTS,
  type CreditPack,
} from '@pagespace/lib/billing/credit-pricing';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';

/** Format whole cents as a dollar string, dropping a trailing ".00" for whole dollars. */
export function formatCreditDollars(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/**
 * Like {@link formatCreditDollars} but signs negatives as `-$X` (not `$-X`), for the
 * credit balance which goes negative when the user owes overage. Zero/positive render
 * identically.
 */
export function formatCreditDollarsSigned(cents: number): string {
  return cents < 0 ? `-${formatCreditDollars(-cents)}` : formatCreditDollars(cents);
}

/**
 * Convert whole cents to a 0–100 display-credit scale where `allowanceCents` = 100.
 * Positive top-up balances can push the result above 100.
 */
export function toDisplayCredits(cents: number, allowanceCents: number): number {
  if (allowanceCents <= 0) return cents;
  return (cents / allowanceCents) * 100;
}

/** Format cents as a display credit amount on the 0–100 scale (2 decimal places). */
export function formatCreditUnits(cents: number, allowanceCents: number): string {
  return toDisplayCredits(cents, allowanceCents).toFixed(2);
}

/** Like {@link formatCreditUnits} but prefixes negative values with a minus sign. */
export function formatCreditUnitsSigned(cents: number, allowanceCents: number): string {
  if (cents < 0) return `-${formatCreditUnits(-cents, allowanceCents)}`;
  return formatCreditUnits(cents, allowanceCents);
}

/** Convert whole cents to credit units (1 credit = $1 = 100 cents). */
export function centsToCredits(cents: number): number {
  return cents / 100;
}

/**
 * Format cents as a credit count. Whole credits show as integers ("5", "15");
 * fractions use one decimal place ("4.7").
 */
export function formatCreditCount(cents: number): string {
  const units = cents / 100;
  return Number.isInteger(units) ? `${units}` : units.toFixed(1);
}

/** Like {@link formatCreditCount} but prefixes negative values with a minus sign. */
export function formatCreditCountSigned(cents: number): string {
  if (cents < 0) return `-${formatCreditCount(-cents)}`;
  return formatCreditCount(cents);
}

/** Bounds (whole cents) for a custom top-up amount, from the canonical billing config. */
export const TOPUP_MIN_CENTS = CREDIT_TOPUP_MIN_CENTS;
export const TOPUP_MAX_CENTS = CREDIT_TOPUP_MAX_CENTS;

/** Monthly included AI-credit allowance per tier, in whole cents. */
export const MONTHLY_CREDIT_CENTS: Record<SubscriptionTier, number> = {
  free: TIER_MONTHLY_ALLOWANCE_CENTS.free,
  pro: TIER_MONTHLY_ALLOWANCE_CENTS.pro,
  founder: TIER_MONTHLY_ALLOWANCE_CENTS.founder,
  business: TIER_MONTHLY_ALLOWANCE_CENTS.business,
};

/** Monthly included AI-credit allowance per tier, as credit unit strings (e.g. "5", "15"). */
export const MONTHLY_CREDITS: Record<SubscriptionTier, string> = {
  free: formatCreditCount(TIER_MONTHLY_ALLOWANCE_CENTS.free),
  pro: formatCreditCount(TIER_MONTHLY_ALLOWANCE_CENTS.pro),
  founder: formatCreditCount(TIER_MONTHLY_ALLOWANCE_CENTS.founder),
  business: formatCreditCount(TIER_MONTHLY_ALLOWANCE_CENTS.business),
};

/** Whether a tier's allowance is re-granted every billing period (free is a one-time grant). */
const CREDITS_REFILL: Record<SubscriptionTier, boolean> = TIER_ALLOWANCE_REFILLS;

/**
 * Allowance phrase for a tier: "15 credits/month" for refilling paid tiers,
 * "5 credits to start" for the free tier's one-time starter grant.
 */
export function monthlyCreditsPhrase(tier: SubscriptionTier): string {
  return CREDITS_REFILL[tier]
    ? `${MONTHLY_CREDITS[tier]} credits/month`
    : `${MONTHLY_CREDITS[tier]} credits to start`;
}

/** Short table-cell form: "15 credits/mo" or "5 credits to start". */
export function creditsCellPhrase(tier: SubscriptionTier, cents: number): string {
  return CREDITS_REFILL[tier]
    ? `${formatCreditCount(cents)} credits/mo`
    : `${formatCreditCount(cents)} credits to start`;
}

/** Buyable top-up packs, sorted by ascending credit value. */
export const CREDIT_PACK_LIST: CreditPack[] = Object.values(CREDIT_PACKS).sort(
  (a, b) => a.cents - b.cents,
);
