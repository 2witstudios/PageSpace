/**
 * credit-copy — the credit phrases plan cards, settings, and the marketing site
 * show, all derived from money-model so no surface can drift from what the app
 * meters. apps/web/src/lib/subscription/credits.ts and
 * apps/marketing/src/lib/credits.ts are thin re-exports of this module and
 * money-model; do not hardcode a credit or pack number anywhere else.
 *
 * Every credit string here is a count (UI-12): no currency symbol. Dollar strings
 * appear only for top-up packs, which are real purchases.
 */

import { TIER_ALLOWANCE_REFILLS } from './credit-pricing';
import {
  CREDIT_PACKS,
  type CreditPack,
  creditPackPriceCents,
  FREE_STARTER_CREDITS,
  centsFromCredits,
  formatCreditCount,
  formatDollars,
  tierAllowanceCents,
} from './money-model';
import { TIERS, type SubscriptionTier } from './subscription-tiers';

function perTier<T>(f: (tier: SubscriptionTier) => T): Record<SubscriptionTier, T> {
  return Object.fromEntries(TIERS.map((tier) => [tier, f(tier)])) as Record<SubscriptionTier, T>;
}

/**
 * Included credit value per tier, in whole cents, sized from the list price (MON-2).
 * The free row is the one-time starter grant (MON-8), not a monthly amount.
 *
 * SERVER-authoritative: computed once at module load from the real MONEY_MODEL_V2.
 * A server render that runs PER REQUEST (an API route, admin, or a marketing page
 * that opts out of static generation via `revalidate`/`dynamic`) always sees the
 * correct number — but a build-time prerender does NOT: `next build` evaluates this
 * module once, using whatever env the Docker builder stage happened to have, and
 * bakes the result into static HTML that a later runtime env flip never reaches
 * (apps/marketing/src/app/pricing/page.tsx sets `revalidate` for exactly this
 * reason — see its own comment). A "use client" component (settings/plan) has the
 * same problem for a different reason — Next.js never inlines a bare, non-
 * NEXT_PUBLIC_ env var into the browser bundle — so it must not read this constant
 * as the final word either; it patches its plan data with the server-supplied
 * number from `/api/subscriptions/status`'s `planCredits` instead (see
 * `apps/web/src/lib/subscription/plans.ts`'s `withCreditOverrides`, and the
 * `*ForCents` functions below it calls to rebuild the phrases from that number).
 */
export const MONTHLY_CREDIT_CENTS: Record<SubscriptionTier, number> = perTier(tierAllowanceCents);

/** Included credits per tier as display counts ("900", "3,000"). */
export const MONTHLY_CREDITS: Record<SubscriptionTier, string> = perTier((tier) =>
  formatCreditCount(MONTHLY_CREDIT_CENTS[tier]),
);

/** The free tier's one-time starter grant as a display count ("500"). */
export const FREE_STARTER_CREDITS_DISPLAY: string = formatCreditCount(centsFromCredits(FREE_STARTER_CREDITS));

/**
 * Allowance phrase for an explicit cents value: "900 credits/month" for refilling
 * paid tiers, "500 credits to start" for a one-time grant. The seam
 * `withCreditOverrides` (apps/web/src/lib/subscription/plans.ts) uses to rebuild a
 * plan's copy from a server-supplied number, without re-deriving the ratio itself.
 */
export function monthlyCreditsPhraseForCents(tier: SubscriptionTier, cents: number): string {
  return TIER_ALLOWANCE_REFILLS[tier]
    ? `${formatCreditCount(cents)} credits/month`
    : `${formatCreditCount(cents)} credits to start`;
}

/**
 * Allowance phrase for a tier: "900 credits/month" for refilling paid tiers,
 * "500 credits to start" for the free tier's one-time starter grant.
 */
export function monthlyCreditsPhrase(tier: SubscriptionTier): string {
  return monthlyCreditsPhraseForCents(tier, MONTHLY_CREDIT_CENTS[tier]);
}

/** Short table-cell form: "900 credits/mo" or "500 credits to start". */
export function creditsCellPhrase(tier: SubscriptionTier, cents: number): string {
  return TIER_ALLOWANCE_REFILLS[tier]
    ? `${formatCreditCount(cents)} credits/mo`
    : `${formatCreditCount(cents)} credits to start`;
}

/**
 * Per-tier allowance phrase for prose / feature rows on the marketing site:
 * "500 to start" for the one-time free grant, "900/mo" for refilling paid tiers.
 */
export function creditsPhrase(tier: SubscriptionTier): string {
  return TIER_ALLOWANCE_REFILLS[tier] ? `${MONTHLY_CREDITS[tier]}/mo` : `${MONTHLY_CREDITS[tier]} to start`;
}

/**
 * Same fact as {@link includedCreditsPhrase}, for an explicit cents value. The seam
 * `withCreditOverrides` uses to rebuild a plan card's copy from a server-supplied
 * number without re-deriving the ratio.
 */
export function includedCreditsPhraseForCents(tier: SubscriptionTier, cents: number): string {
  return TIER_ALLOWANCE_REFILLS[tier]
    ? `${formatCreditCount(cents)} credits included each month`
    : `${formatCreditCount(cents)} credits to start`;
}

/**
 * MON-6: the plan card's "included credits" fact — an integer credit COUNT, never a
 * dollar figure. "900 credits included each month" for refilling paid tiers, "500
 * credits to start" for the free tier's one-time grant. Sized by money-model, so the
 * MONEY_MODEL_V2 ratio flips this copy with a rebuild, not a code change.
 */
export function includedCreditsPhrase(tier: SubscriptionTier): string {
  return includedCreditsPhraseForCents(tier, MONTHLY_CREDIT_CENTS[tier]);
}

/** Buyable top-up packs, sorted by ascending credit count. */
export const CREDIT_PACK_LIST: CreditPack[] = Object.values(CREDIT_PACKS).sort((a, b) => a.credits - b.credits);

/** Buyable top-up packs as dollar price strings (e.g. "$10"), sorted by value. Real purchases. */
export const CREDIT_PACKS_DISPLAY: string[] = CREDIT_PACK_LIST.map((pack) => formatDollars(creditPackPriceCents(pack)));

/** Top-up packs joined for prose, e.g. "$10, $25, or $50". */
export function creditPacksPhrase(): string {
  const packs = CREDIT_PACKS_DISPLAY;
  if (packs.length <= 1) return packs.join('');
  return `${packs.slice(0, -1).join(', ')}, or ${packs[packs.length - 1]}`;
}

/**
 * MON-6 / MON-4: the plan card's "top-up rate" fact, from the smallest buyable pack
 * ("1,000 credits per $10"): the credit figure is a count, the dollar figure a real
 * purchase price and NO ratio is applied (unlike a subscription's included credits).
 * The same on every card — the rate is a property of the money model, not of a tier.
 */
export function topUpRatePhrase(): string {
  const smallest = CREDIT_PACK_LIST[0];
  return `${formatCreditCount(centsFromCredits(smallest.credits))} credits per ${formatDollars(creditPackPriceCents(smallest))}`;
}
