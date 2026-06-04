/**
 * Marketing-facing AI-credit copy helpers — the SINGLE SOURCE OF TRUTH for any
 * credit/pricing number shown on the marketing site.
 *
 * Every dollar figure here is derived directly from the canonical billing
 * constants in `@pagespace/lib/billing/credit-pricing`
 * (`TIER_MONTHLY_ALLOWANCE_CENTS` and `CREDIT_PACKS`) so public pricing copy can
 * never drift from what the app actually meters. Do NOT hardcode tier dollar
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

/**
 * TRANSITION: whether to show the "AI credits pricing is rolling out" disclaimer across
 * the marketing site. The site advertises the new credit model, but production accounts
 * may still be on the legacy daily-limit experience until the app's per-environment
 * `CREDITS_ENFORCEMENT_ENABLED` flag is flipped on. Flip this to `false` (then delete the
 * treatment) once AI credits are live for all accounts. Marketing is one global SSG site,
 * so this is a deliberate constant — NOT the app's per-deploy flag.
 */
export const CREDITS_IN_TRANSITION = false;

/** Format whole cents as a plain dollar string, dropping a trailing ".00". */
function formatDollars(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** Monthly included AI-credit allowance per tier, as display strings (e.g. "$5"). */
export const MONTHLY_CREDITS: Record<SubscriptionTier, string> = {
  free: formatDollars(TIER_MONTHLY_ALLOWANCE_CENTS.free),
  pro: formatDollars(TIER_MONTHLY_ALLOWANCE_CENTS.pro),
  founder: formatDollars(TIER_MONTHLY_ALLOWANCE_CENTS.founder),
  business: formatDollars(TIER_MONTHLY_ALLOWANCE_CENTS.business),
};

/** "$5/month in AI credits" style phrase for a tier. */
export function monthlyCreditsPhrase(tier: SubscriptionTier): string {
  return `${MONTHLY_CREDITS[tier]}/month in AI credits`;
}

/** Buyable top-up packs as display strings (e.g. "$10"), sorted by value. */
export const CREDIT_PACKS_DISPLAY: string[] = Object.values(CREDIT_PACKS)
  .sort((a, b) => a.cents - b.cents)
  .map((pack) => formatDollars(pack.cents));

/** Top-up packs joined for prose, e.g. "$10, $25, or $50". */
export function creditPacksPhrase(): string {
  const packs = CREDIT_PACKS_DISPLAY;
  if (packs.length <= 1) return packs.join("");
  return `${packs.slice(0, -1).join(", ")}, or ${packs[packs.length - 1]}`;
}
