/**
 * Marketing-facing credit copy helpers — the SINGLE SOURCE OF TRUTH for any
 * credit number shown on the marketing site.
 *
 * Monthly allowance values are derived directly from the canonical billing
 * constants in `@pagespace/lib/billing/credit-pricing`
 * (`TIER_MONTHLY_ALLOWANCE_CENTS` and `CREDIT_PACKS`) so public pricing copy can
 * never drift from what the app actually meters. Do NOT hardcode tier credit
 * amounts or top-up pack values anywhere else in `apps/marketing` — import from
 * this module instead. If the allowances change in `credit-pricing.ts`, the
 * pricing page, FAQ, Terms, docs, schema.org markup, and search index all update
 * automatically.
 */
import {
  TIER_MONTHLY_ALLOWANCE_CENTS,
  CREDIT_PACKS,
} from "@pagespace/lib/billing/credit-pricing";
import type { SubscriptionTier } from "@pagespace/lib/services/subscription-utils";

/** Format whole cents as a plain credit quantity string, dropping a trailing ".00". */
function formatCredits(cents: number): string {
  const units = cents / 100;
  return Number.isInteger(units) ? `${units}` : `${units.toFixed(2)}`;
}

/** Format whole cents as a dollar price string (for real purchase amounts). */
function formatPrice(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** Monthly included credit allowance per tier, as display strings (e.g. "5", "15"). */
export const MONTHLY_CREDITS: Record<SubscriptionTier, string> = {
  free: formatCredits(TIER_MONTHLY_ALLOWANCE_CENTS.free),
  pro: formatCredits(TIER_MONTHLY_ALLOWANCE_CENTS.pro),
  founder: formatCredits(TIER_MONTHLY_ALLOWANCE_CENTS.founder),
  business: formatCredits(TIER_MONTHLY_ALLOWANCE_CENTS.business),
};

/** Buyable top-up packs as dollar price strings (e.g. "$10"), sorted by value. */
export const CREDIT_PACKS_DISPLAY: string[] = Object.values(CREDIT_PACKS)
  .sort((a, b) => a.cents - b.cents)
  .map((pack) => formatPrice(pack.cents));

/** Top-up packs joined for prose, e.g. "$10, $25, or $50". */
export function creditPacksPhrase(): string {
  const packs = CREDIT_PACKS_DISPLAY;
  if (packs.length <= 1) return packs.join("");
  return `${packs.slice(0, -1).join(", ")}, or ${packs[packs.length - 1]}`;
}
