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
  allowanceCentsForPaidCents,
  creditPackPriceCents,
  FREE_STARTER_CREDITS,
  centsFromCredits,
  centsFromDollars,
  formatCreditCount,
  formatDollars,
  tierAllowanceCents,
  tierListPriceCents,
} from './money-model';
import { TIERS, TIER_PLAN_LIMITS, type SubscriptionTier } from './subscription-tiers';

function perTier<T>(f: (tier: SubscriptionTier) => T): Record<SubscriptionTier, T> {
  return Object.fromEntries(TIERS.map((tier) => [tier, f(tier)])) as Record<SubscriptionTier, T>;
}

/**
 * Included credit value per tier, in whole cents, sized from the list price (MON-2).
 * The free row is the one-time starter grant (MON-8), not a monthly amount.
 *
 * D-OW-17: correct EVERYWHERE, unconditionally — a build-time prerender, a
 * per-request server render, and a "use client" browser bundle all compile this
 * module from the same source at the same commit, so they all embed the same
 * `MONEY_MODEL_V2_ACTIVE` literal. There is no env var to read differently per
 * process and no client/server asymmetry left to patch around; see money-model.ts's
 * module doc comment for why earlier revisions of this fix (a server env var, then a
 * `NEXT_PUBLIC_` mirror, then a server-computed patch) each failed to guarantee that.
 *
 * `apps/web/src/lib/subscription/plans.ts`'s `withCreditOverrides` (and the
 * `*ForCents` functions below it calls) still exist and are still correct to use —
 * they are simply no longer load-bearing for THIS defect now that the constant is
 * identical everywhere by construction.
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
 * credits to start" for the free tier's one-time grant. Sized by money-model, so
 * flipping `MONEY_MODEL_V2_ACTIVE` (a commit, D-OW-17) flips this copy everywhere.
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

/** The org plan's own facts on a plan card (SEAT-2, A-7, A-11); absent on a personal plan. */
export interface OrgPlanFacts {
  includedSeats: number;
  /** Real money, whole cents. */
  extraSeatPriceCents: number;
  /** "per organization · 5 seats included · $10 per extra seat a month". */
  seatTerms: string;
  /** "+1,000 credits a month per extra seat": a count, never a dollar figure (UI-12). */
  extraSeatCredits: string;
  /** D-OW-30: no org trial; a card is required at checkout. */
  checkout: string;
}

/** Everything a plan card states for one tier, so the marketing page and the in-app card cannot disagree. */
export interface PlanFacts {
  tier: SubscriptionTier;
  name: string;
  /** Real money, whole cents. */
  priceCents: number;
  /** "$15": the only dollar figure on the card besides the seat price and the top-up rate's purchase price. */
  price: string;
  /** "/month" for a paid tier, null for free. */
  period: string | null;
  /** MON-6 second fact: "1,500 credits included each month" / "500 credits to start". */
  includedCredits: string;
  /** MON-6 third fact: "1,000 credits per $10". */
  topUpRate: string;
  org: OrgPlanFacts | null;
}

/**
 * MON-6 / SEAT-2 / UI-12: the plan-card facts for `tier`, every number derived from
 * the tier table and money-model. `active` defaults to the committed ratio constant
 * (D-OW-17); tests pass it to render both sides of the migration-day flip.
 */
export function planFacts(tier: SubscriptionTier, active?: boolean): PlanFacts {
  const limits = TIER_PLAN_LIMITS[tier];
  const priceCents = tierListPriceCents(tier);
  return {
    tier,
    name: limits.name,
    priceCents,
    price: formatDollars(priceCents),
    period: priceCents > 0 ? '/month' : null,
    includedCredits: includedCreditsPhraseForCents(tier, tierAllowanceCents(tier, active)),
    topUpRate: topUpRatePhrase(),
    org: limits.isOrgPlan ? orgPlanFacts(tier, active) : null,
  };
}

function orgPlanFacts(tier: SubscriptionTier, active?: boolean): OrgPlanFacts {
  const limits = TIER_PLAN_LIMITS[tier];
  const extraSeatPriceCents = centsFromDollars(limits.extraSeatUsd);
  const seatCredits = formatCreditCount(allowanceCentsForPaidCents(extraSeatPriceCents, tier, active));
  return {
    includedSeats: limits.includedSeats,
    extraSeatPriceCents,
    seatTerms: `per organization · ${limits.includedSeats} seats included · ${formatDollars(extraSeatPriceCents)} per extra seat a month`,
    extraSeatCredits: `+${seatCredits} credits a month per extra seat`,
    checkout: 'No trial · card required at checkout',
  };
}
