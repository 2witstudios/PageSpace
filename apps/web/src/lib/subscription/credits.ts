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

/** Monthly included AI-credit allowance per tier, as display strings (e.g. "$5"). */
export const MONTHLY_CREDITS: Record<SubscriptionTier, string> = {
  free: formatCreditDollars(TIER_MONTHLY_ALLOWANCE_CENTS.free),
  pro: formatCreditDollars(TIER_MONTHLY_ALLOWANCE_CENTS.pro),
  founder: formatCreditDollars(TIER_MONTHLY_ALLOWANCE_CENTS.founder),
  business: formatCreditDollars(TIER_MONTHLY_ALLOWANCE_CENTS.business),
};

/** "$5/month in AI credits" style phrase for a tier. */
export function monthlyCreditsPhrase(tier: SubscriptionTier): string {
  return `${MONTHLY_CREDITS[tier]}/month in AI credits`;
}

/** Buyable top-up packs, sorted by ascending credit value. */
export const CREDIT_PACK_LIST: CreditPack[] = Object.values(CREDIT_PACKS).sort(
  (a, b) => a.cents - b.cents,
);

/** Buyable top-up packs as display strings (e.g. "$10"), sorted by value. */
export const CREDIT_PACKS_DISPLAY: string[] = CREDIT_PACK_LIST.map((pack) =>
  formatCreditDollars(pack.cents),
);

/** Top-up packs joined for prose, e.g. "$10, $25, or $50". */
export function creditPacksPhrase(): string {
  const packs = CREDIT_PACKS_DISPLAY;
  if (packs.length <= 1) return packs.join('');
  return `${packs.slice(0, -1).join(', ')}, or ${packs[packs.length - 1]}`;
}
