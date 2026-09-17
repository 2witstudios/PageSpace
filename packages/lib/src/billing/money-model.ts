/**
 * money-model — THE definition of price, credits, and the ratio between them
 * (Spec MON-1..MON-8, A-11).
 *
 * A credit is not a dollar. This module is the only place that states:
 *   - MARKUP_BPS: what real provider cost is marked up by before it is charged;
 *   - CREDITS_PER_DOLLAR: the purchase and display rate of a credit;
 *   - INCLUDED_CREDIT_RATIO_BPS: the share of a subscription's price paid that is
 *     granted back as credit value each period;
 *   - FREE_STARTER_CREDITS: the one-time free grant, a plain count;
 *   - CREDIT_PACKS and the custom top-up bounds, as credit counts priced from the
 *     rate with no ratio (MON-4);
 *   - the conversions between cents, credits, and dollars, and the one formatter
 *     that renders a credit amount.
 *
 * No other file may tabulate an allowance, a pack size, or a credit-to-money
 * conversion (money-model-guard.test.ts greps for `/ 100` and `* 100` on any cents
 * or credit value outside this file). Balances are still stored in whole cents of
 * credit VALUE — `creditBalances.*Cents`, the ledger, holds — and this module is how
 * those cents become the counts a person sees.
 *
 * MONEY_MODEL_V2_ACTIVE (D-OW-17) gates only the RATIO. Off, a paid tier is granted
 * 100% of its price as credit value, which is exactly today's tabulated allowance
 * (Pro $15 → 1500¢), so balances compute as before until migration day flips it. The
 * rate and the formatter are not gated: a credit is CREDITS_PER_DOLLAR⁻¹ of a dollar
 * everywhere, immediately.
 *
 * D-OW-17: the ratio switch is a CODE CONSTANT, not a runtime env var. An earlier
 * revision of this fix used a server env var (`MONEY_MODEL_V2`), then a client-visible
 * `NEXT_PUBLIC_` mirror of it, then a server-computed value patched onto the client
 * after the fact — three attempts at the same problem: a value that must read
 * identically in every process (web, marketing, a "use client" bundle) cannot be a
 * value each process reads independently, because nothing enforces that they agree.
 * Only a value baked into the shared source at build time — this constant — is
 * identical everywhere by construction: web and marketing both compile
 * `@pagespace/lib` from the same commit, so both embed the same literal, and a "use
 * client" bundle embeds it too, no different from any other compile-time constant.
 * Flipping it is a commit (migration day), deployed to every app together — never an
 * env var an operator sets on a subset of processes. `MONEY_MODEL_V2_ACTIVE` is FALSE
 * in this PR; a follow-up commit on migration day changes the literal.
 *
 * The seam guard `packages/lib/src/__tests__/seams/credit-conversion.seam.test.ts`
 * fails if any file (this one included) reads `process.env.MONEY_MODEL_V2` — that
 * name must never come back.
 */

import { envInt } from './env-parse';
import { TIER_PLAN_LIMITS, isSubscriptionTier, type SubscriptionTier } from './subscription-tiers';

/** Markup applied to real provider cost, in basis points. 15000 = 1.5×. */
export const MARKUP_BPS = envInt('CREDIT_MARKUP_BPS', 15000);

/** One dollar is 100 cents. Stated once; every cents↔dollars conversion goes through here. */
const CENTS_PER_DOLLAR = 100;

/** The purchase and display rate: a dollar of credit value is this many credits (A-11). */
export const CREDITS_PER_DOLLAR = 100;

/**
 * Share of a subscription's PAID amount granted as credit value each period, in
 * basis points (A-11: 60% for Pro and Business; free pays nothing and derives
 * nothing). Keyed by the canonical vocabulary, so removing a tier from TIERS (lane
 * A2 removes Founder, A-9) makes its row a compile error until it is removed too —
 * the two tables cannot drift apart.
 */
export const INCLUDED_CREDIT_RATIO_BPS: Record<SubscriptionTier, number> = {
  free: 0,
  pro: 6000,
  business: 6000,
};

/**
 * The ratio in force with the money model off: the whole price paid becomes credit
 * value, which reproduces the old tabulated allowances exactly.
 */
const LEGACY_INCLUDED_CREDIT_RATIO_BPS = 10_000;

/**
 * One-time starter grant for the free tier, as a plain credit count (MON-8). Not
 * derived from any price. 500 credits = $5 of credit value at CREDITS_PER_DOLLAR,
 * unchanged from the previous $5 starter grant.
 */
export const FREE_STARTER_CREDITS = 500;

/**
 * D-OW-17: whether the decoupled money model (the 60% ratio) is active — a CODE
 * CONSTANT, never a runtime env var (see the module doc comment for why). FALSE in
 * this PR; migration day changes this literal in a follow-up commit.
 */
export const MONEY_MODEL_V2_ACTIVE = false;

/**
 * Whether the decoupled money model is active. Takes no argument and returns
 * {@link MONEY_MODEL_V2_ACTIVE} directly — kept as a named predicate for callers that
 * want the flag itself rather than a derived number.
 */
export function isMoneyModelV2Enabled(): boolean {
  return MONEY_MODEL_V2_ACTIVE;
}

/**
 * The included-credit ratio for `tier`, in basis points. 0 for the free tier and for
 * any unknown/legacy value (nothing is paid, so nothing derives). Accepts the raw
 * `users.subscriptionTier` string.
 *
 * PURE: `active` is an explicit parameter, not a hidden read of global state — this
 * is the actual ratio-selection step D-OW-17 asked to be testable in isolation, with
 * no env mutation and no module-load timing to manage. Defaults to
 * {@link MONEY_MODEL_V2_ACTIVE}, so every production call site (which never passes a
 * third/second argument) gets the real constant "for free"; tests pass `true`/`false`
 * directly to exercise both branches.
 */
export function includedCreditRatioBps(tier: string, active: boolean = MONEY_MODEL_V2_ACTIVE): number {
  if (!isSubscriptionTier(tier)) return 0;
  const ratio = INCLUDED_CREDIT_RATIO_BPS[tier];
  if (ratio <= 0) return 0;
  return active ? ratio : LEGACY_INCLUDED_CREDIT_RATIO_BPS;
}

/**
 * MON-2: allowanceCents = paidCents × ratio, computed from what the invoice actually
 * paid so a price change, a promo, or a partial period flows through without a
 * table edit. Floored to whole cents (never grants more than the ratio of what was
 * paid); fails closed — a negative or non-finite amount, or a tier with no ratio,
 * grants nothing. `active` defaults to {@link MONEY_MODEL_V2_ACTIVE}, same as
 * {@link includedCreditRatioBps}.
 */
export function allowanceCentsForPaidCents(
  paidCents: number,
  tier: SubscriptionTier,
  active: boolean = MONEY_MODEL_V2_ACTIVE,
): number {
  if (!Number.isFinite(paidCents) || paidCents <= 0) return 0;
  const ratio = includedCreditRatioBps(tier, active);
  if (ratio <= 0) return 0;
  return Math.floor((paidCents * ratio) / 10_000);
}

/** A tier's monthly list price in whole cents, from the canonical tier table. */
export function tierListPriceCents(tier: SubscriptionTier): number {
  return centsFromDollars(TIER_PLAN_LIMITS[tier].priceMonthlyUsd);
}

/**
 * The grant a tier receives when there is no invoice to size it from: the gate's
 * own period roll for comped/no-subscription paid accounts, the lazy-init of a
 * brand-new balance row, and display of an account that has never been granted.
 * Paid tiers derive from the list price; free is the starter grant; an
 * unknown/legacy value (e.g. a stale `users.subscriptionTier`) is treated as free so
 * it is never handed a paid allowance. Accepts the raw column string. `active`
 * defaults to {@link MONEY_MODEL_V2_ACTIVE}, same as {@link allowanceCentsForPaidCents}.
 */
export function tierAllowanceCents(tier: string, active: boolean = MONEY_MODEL_V2_ACTIVE): number {
  if (isSubscriptionTier(tier) && tier !== 'free') {
    return allowanceCentsForPaidCents(tierListPriceCents(tier), tier, active);
  }
  return centsFromCredits(FREE_STARTER_CREDITS);
}

/**
 * Cents of credit value → credit count. Multiplies before dividing: a whole-cent input
 * gives an exact integer product, and while CENTS_PER_DOLLAR divides that product
 * evenly (true while it equals CREDITS_PER_DOLLAR) the quotient is exact too.
 * Divide-then-multiply drifts ((7 / 100) * 100 is 7.000000000000001).
 */
export function creditsFromCents(cents: number): number {
  return (cents * CREDITS_PER_DOLLAR) / CENTS_PER_DOLLAR;
}

/**
 * Credit count → cents of credit value. Multiplies before dividing, so a whole credit
 * count gives exact integer cents while CREDITS_PER_DOLLAR divides the product evenly
 * (true while it equals CENTS_PER_DOLLAR) — the figure goes to Stripe as
 * `unit_amount`, which rejects a non-integer. A rate that does not divide evenly makes
 * a credit a fraction of a cent, and the MON-5 exact-integer test fails on purpose.
 */
export function centsFromCredits(credits: number): number {
  return (credits * CENTS_PER_DOLLAR) / CREDITS_PER_DOLLAR;
}

/** Whole cents → dollars (real money, for prices, invoices, and top-up purchases). */
export function dollarsFromCents(cents: number): number {
  return cents / CENTS_PER_DOLLAR;
}

/** Dollars → whole cents (real money), rounded to the nearest cent. */
export function centsFromDollars(dollars: number): number {
  return Math.round(dollars * CENTS_PER_DOLLAR);
}

const creditCountFormat = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
  useGrouping: true,
});

/**
 * MON-5 / UI-12: render cents of credit value as an integer credit count with
 * thousands separators — "900", "1,200", "9,000" — never a decimal, never a dollar
 * sign. Rounds to the nearest whole credit; an overage (negative) keeps its minus.
 */
export function formatCreditCount(cents: number): string {
  const credits = Math.round(creditsFromCents(cents));
  // Math.round(-0.2) is -0, which would print as "-0".
  return creditCountFormat.format(credits === 0 ? 0 : credits);
}

/**
 * Format whole cents as a dollar price string ("$10", "$10.50"), dropping a trailing
 * ".00" for whole dollars. Real money only: plan prices, seat prices, top-up bounds.
 */
export function formatDollars(cents: number): string {
  const dollars = dollarsFromCents(cents);
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** Dollars → credits at the purchase rate (MON-4): $12.34 buys 1,234 credits. */
export function creditsFromDollars(dollars: number): number {
  return Math.round(dollars * CREDITS_PER_DOLLAR);
}

export interface CreditPack {
  /** Stable SKU id, round-tripped through Stripe checkout metadata (`packId`). */
  id: string;
  /** Credits added to the never-expiring top-up bucket. */
  credits: number;
  /** Human label for the purchase menu and receipts: a credit count, never a price. */
  label: string;
}

function creditPack(id: string, credits: number): CreditPack {
  return { id, credits, label: `${formatCreditCount(centsFromCredits(credits))} credits` };
}

/**
 * One-time top-up packs offered for purchase, defined as credit counts (MON-4). The
 * SKU ids are stable (they predate the credit denomination and live in Stripe
 * metadata and the e2e seed); the price comes from {@link creditPackPriceCents}.
 */
export const CREDIT_PACKS: Record<string, CreditPack> = {
  pack_10: creditPack('pack_10', 1000),
  pack_25: creditPack('pack_25', 2500),
  pack_50: creditPack('pack_50', 5000),
};

export function getCreditPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS[id];
}

/**
 * MON-4: what a pack costs, in whole cents, at CREDITS_PER_DOLLAR with NO ratio
 * applied — a top-up buys credit value one-for-one, unlike a subscription's included
 * credits. The checkout line item's `unit_amount` and the funding ledger both use
 * this figure.
 */
export function creditPackPriceCents(pack: CreditPack): number {
  return centsFromCredits(pack.credits);
}

/**
 * Bounds, in credits, for a CUSTOM top-up alongside the fixed packs. The min keeps
 * dust purchases above Stripe's per-transaction fee; the max caps single-charge
 * fraud/chargeback exposure. Default 500–50,000 credits ($5–$500); tune via env.
 */
export const CREDIT_TOPUP_MIN_CREDITS = envInt('CREDIT_TOPUP_MIN_CREDITS', 500);
export const CREDIT_TOPUP_MAX_CREDITS = envInt('CREDIT_TOPUP_MAX_CREDITS', 50_000);

/**
 * Normalize and bound a user-supplied custom top-up, in credits (MON-4). Returns the
 * integer credit count, or null if it is not a finite integer within [min, max].
 * Pure, so the checkout route and the client validate against the SAME rule.
 */
export function validateTopupCredits(
  credits: number,
  minCredits: number = CREDIT_TOPUP_MIN_CREDITS,
  maxCredits: number = CREDIT_TOPUP_MAX_CREDITS,
): number | null {
  if (!Number.isInteger(credits)) return null;
  if (credits < minCredits || credits > maxCredits) return null;
  return credits;
}
