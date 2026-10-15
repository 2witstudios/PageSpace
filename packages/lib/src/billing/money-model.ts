/**
 * money-model — THE definition of price, credits, and the ratio between them
 * (Spec MON-1..MON-8, A-11).
 *
 * A credit is not a dollar. This module is the only place that states:
 *   - MARKUP_BPS: what real provider cost is marked up by before it is charged (and
 *     MACHINE_MARKUP_BPS, its separately floored twin for Machine substrate cost);
 *   - CREDITS_PER_DOLLAR: the purchase and display rate of a credit;
 *   - INCLUDED_CREDIT_RATIO_BPS: the share of a subscription's price paid that is
 *     granted back as credit value each period;
 *   - FREE_STARTER_CREDITS: the one-time free grant, a plain count;
 *   - the org seat allowance default and ceiling, and the per-consumer cap defaults
 *     ([D-OW-31]);
 *   - CREDIT_PACKS and the custom top-up bounds, as credit counts priced from the
 *     rate with no ratio (MON-4);
 *   - the conversions between cents, credits, and dollars, and the one formatter
 *     that renders a credit amount.
 *
 * No other file may tabulate an allowance, a pack size, or a credit-to-money
 * conversion (money-model-guard.test.ts greps for `/ 100` and `* 100` on any cents
 * or credit value outside this file). Balances are still stored in whole cents of
 * credit VALUE — `wallets.*Cents`, the ledger, holds — and this module is how
 * those cents become the counts a person sees.
 *
 * D-OW-17 / D-OW-42: the ratio is in force unconditionally. It was staged behind a
 * code constant (`MONEY_MODEL_V2_ACTIVE`), flipped by one migration commit and then
 * removed with every legacy 100%-of-price branch — the full cutover leaves no
 * reversibility switch. A value that must read identically in every process (web,
 * marketing, a "use client" bundle) is a literal in this shared source, never an env
 * var: the seam guard `packages/lib/src/__tests__/seams/credit-conversion.seam.test.ts`
 * fails if any file reads `process.env.MONEY_MODEL_V2`.
 */

import { envInt } from './env-parse';
import { TIER_PLAN_LIMITS, isSubscriptionTier, type SubscriptionTier } from './subscription-tiers';

/** Markup applied to real provider cost, in basis points. 15000 = 1.5×. */
export const MARKUP_BPS = envInt('CREDIT_MARKUP_BPS', 15000);

/**
 * Absolute floor for {@link MACHINE_MARKUP_BPS} — 15000bps (1.5x). The whole
 * point of that constant is to GUARANTEE Machine billing never falls below
 * 1.5x real substrate cost, independent of {@link MARKUP_BPS}; an env
 * misconfiguration (typo, someone mirroring a reduced AI markup) must not be
 * able to silently violate that guarantee. Only a value BELOW this floor is
 * clamped up — a deliberately higher markup passes through unclamped, since
 * there is no stated ceiling.
 */
export const MACHINE_MARKUP_FLOOR_BPS = 15000;

/**
 * Markup applied to Machine substrate cost, in basis points — the
 * founder-set floor of 1.5× real substrate cost. Deliberately a SEPARATE env
 * var and constant from {@link MARKUP_BPS} (not derived from it): AI-model
 * pricing and substrate-runtime pricing are different economics that may
 * diverge, so lowering `CREDIT_MARKUP_BPS` for AI billing must never silently
 * lower what a Machine is charged. Threaded into `consumeCredits` via
 * `markupBpsOverride` (see machine-billing.ts's `trackUsage`) so the real
 * settle path enforces this floor independent of the shared default. Clamped
 * to {@link MACHINE_MARKUP_FLOOR_BPS} so a misconfigured env var can raise
 * the markup but never lower it below the documented floor.
 */
export const MACHINE_MARKUP_BPS = Math.max(
  envInt('MACHINE_MARKUP_BPS', MACHINE_MARKUP_FLOOR_BPS),
  MACHINE_MARKUP_FLOOR_BPS,
);

/**
 * One dollar is 100 cents. Stated once; every cents↔dollars conversion goes through here.
 * Exported for SQL that multiplies in the database (`${cost} * ${CENTS_PER_DOLLAR}`), where
 * no function can run; everything else calls the helpers below.
 */
export const CENTS_PER_DOLLAR = 100;

/** Sub-cent accrual unit: a thousandth of a cent (credit-core `pendingMillicents`). */
const MILLICENTS_PER_CENT = 1000;

/** The purchase and display rate: a dollar of credit value is this many credits (A-11). */
export const CREDITS_PER_DOLLAR = 10;

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
 * One-time starter grant for the free tier, as a plain credit count (MON-8). Not
 * derived from any price. 50 credits = $5 of credit value at CREDITS_PER_DOLLAR,
 * unchanged from the previous $5 starter grant.
 */
export const FREE_STARTER_CREDITS = 50;

/**
 * The org's default seat allowance, in credits a month per member (WAL-2, the POL-7 policy
 * default and the fallback when an org sets none): D20.5's $1, now 10 credits. Its own figure
 * on purpose: [D-OW-31] moved the per-consumer cap defaults and left the seat allowance where it was, so a
 * cap edit must never move what every member may draw from every pool.
 */
export const DEFAULT_SEAT_ALLOWANCE_CREDITS = 10;

/**
 * The most a seat allowance may be set to: 10,000,000 cents of credit value a month per
 * member. A ceiling exists so "a very large number" is not "unlimited by another name": the
 * cap arithmetic multiplies cents into millicents, and an unbounded value would walk toward
 * 2^53 there.
 */
export const MAX_SEAT_ALLOWANCE_CENTS = 10_000_000;

/**
 * Per-consumer cap defaults when an admin enables caps without naming values, in credits
 * ([D-OW-31]: $0.50 a day and $10 a month, 5 and 100 credits, replacing D20.5's $0.10/$1,
 * which sat below one image or uncatalogued model's hold and so refused every such call).
 */
export const DEFAULT_CONSUMER_CAP_CREDITS = { daily: 5, monthly: 100 } as const;

/**
 * The included-credit ratio for `tier`, in basis points. 0 for the free tier and for
 * any unknown/legacy value (nothing is paid, so nothing derives). Accepts the raw
 * `users.subscriptionTier` string.
 */
export function includedCreditRatioBps(tier: string): number {
  if (!isSubscriptionTier(tier)) return 0;
  return Math.max(0, INCLUDED_CREDIT_RATIO_BPS[tier]);
}

/**
 * MON-2: allowanceCents = paidCents × ratio, computed from what the invoice actually
 * paid so a price change, a promo, or a partial period flows through without a
 * table edit. Floored to whole cents (never grants more than the ratio of what was
 * paid); fails closed — a negative or non-finite amount, or a tier with no ratio,
 * grants nothing.
 */
export function allowanceCentsForPaidCents(paidCents: number, tier: SubscriptionTier): number {
  if (!Number.isFinite(paidCents) || paidCents <= 0) return 0;
  const ratio = includedCreditRatioBps(tier);
  if (ratio <= 0) return 0;
  return Math.floor((paidCents * ratio) / 10_000);
}

/** A tier's monthly list price in whole cents, from the canonical tier table. */
export function tierListPriceCents(tier: SubscriptionTier): number {
  return centsFromDollars(TIER_PLAN_LIMITS[tier].priceMonthlyUsd);
}

/**
 * The grant a tier receives when there is no invoice to size it from: the period
 * sweep's roll for comped/no-subscription paid accounts, the lazy-init of a
 * brand-new balance row, and display of an account that has never been granted.
 * Paid tiers derive from the list price; free is the starter grant; an
 * unknown/legacy value (e.g. a stale `users.subscriptionTier`) is treated as free so
 * it is never handed a paid allowance. Accepts the raw column string.
 */
export function tierAllowanceCents(tier: string): number {
  if (isSubscriptionTier(tier) && tier !== 'free') {
    return allowanceCentsForPaidCents(tierListPriceCents(tier), tier);
  }
  return centsFromCredits(FREE_STARTER_CREDITS);
}

/**
 * Cents of credit value in one credit. Derived from the two rates so it cannot drift from
 * them; must be a whole number (a credit is never a fraction of a cent — the MON-5
 * exact-integer test fails on purpose if a rate change breaks that).
 */
const CENTS_PER_CREDIT = CENTS_PER_DOLLAR / CREDITS_PER_DOLLAR;

/**
 * Cents of credit value → credit count. One correctly rounded division, so the result
 * round-trips through {@link centsFromCredits} exactly for every whole-cent input. A
 * balance that is not a whole number of credits gives a fractional count; display rounds
 * it ({@link formatCreditCount}).
 */
export function creditsFromCents(cents: number): number {
  return cents / CENTS_PER_CREDIT;
}

/**
 * Credit count → cents of credit value. A whole credit count gives exact integer cents
 * (CENTS_PER_CREDIT is a whole number) — the figure goes to Stripe as `unit_amount`,
 * which rejects a non-integer.
 */
export function centsFromCredits(credits: number): number {
  return credits * CENTS_PER_CREDIT;
}

/** Whole cents → dollars (real money, for prices, invoices, and top-up purchases). */
export function dollarsFromCents(cents: number): number {
  return cents / CENTS_PER_DOLLAR;
}

/**
 * Cents of credit value CHARGED → the real provider cost, in dollars, they cover: the
 * inverse of the markup applied at settle. A credit hold is sized in charged cents, so a
 * cap on the provider cost of a call comes back through here. Multiplies before dividing
 * (cents × 10000 / (markup × 100)), never cents / 100 / (markup / 10000).
 */
export function providerDollarsCoveredByCents(cents: number, markupBps: number = MARKUP_BPS): number {
  return (cents * 10_000) / (markupBps * CENTS_PER_DOLLAR);
}

/**
 * Dollars → cents with NO rounding, for a caller whose rounding is its own rule: a hold
 * that ceils, a billing-off ceiling that floors a float SUM, a floor that ceils after a
 * markup. Everyone else wants {@link centsFromDollars}.
 */
export function exactCentsFromDollars(dollars: number): number {
  return dollars * CENTS_PER_DOLLAR;
}

/** Dollars → whole cents (real money), rounded to the nearest cent. */
export function centsFromDollars(dollars: number): number {
  return Math.round(exactCentsFromDollars(dollars));
}

/**
 * Real provider cost, in dollars → the cents of credit value it is CHARGED at settle:
 * the markup, then the conversion, unrounded (credit-core's markupCents rounds it; a
 * TTS hold ceils it). The inverse of {@link providerDollarsCoveredByCents}.
 */
export function chargedCentsFromProviderDollars(realCostDollars: number, markupBps: number = MARKUP_BPS): number {
  return exactCentsFromDollars(realCostDollars * (markupBps / 10_000));
}

/** Millicents (the accrual unit) → cents, unrounded. */
export function centsFromMillicents(millicents: number): number {
  return millicents / MILLICENTS_PER_CENT;
}

/** Cents → millicents (the accrual unit). */
export function millicentsFromCents(cents: number): number {
  return cents * MILLICENTS_PER_CENT;
}

/**
 * The same charge in millicents (a thousandth of a cent), unrounded — the fine unit
 * settle accrues so a sub-cent call is never billed nothing (credit-core chargeMillicents).
 */
export function chargedMillicentsFromProviderDollars(realCostDollars: number, markupBps: number = MARKUP_BPS): number {
  return realCostDollars * (markupBps / 10_000) * (CENTS_PER_DOLLAR * MILLICENTS_PER_CENT);
}

const creditCountFormat = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
  useGrouping: true,
});

/**
 * MON-5 / UI-12: render cents of credit value as an integer credit count with
 * thousands separators — "90", "1,200", "9,000" — never a decimal, never a dollar
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

/**
 * Dollars → credits at the purchase rate (MON-4): $12.30 buys 123 credits. Never rounds to
 * a whole credit: an amount that is not one ($5.04 is 50.4 credits) comes back fractional,
 * so validateTopupCredits refuses it instead of silently charging a different amount.
 * The dollars are first taken to the nearest cent, so float input like 12.3 is exact.
 */
export function creditsFromDollars(dollars: number): number {
  return creditsFromCents(centsFromDollars(dollars));
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
  pack_10: creditPack('pack_10', 100),
  pack_25: creditPack('pack_25', 250),
  pack_50: creditPack('pack_50', 500),
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
 * fraud/chargeback exposure. Default 50–5,000 credits ($5–$500); tune via env.
 */
export const CREDIT_TOPUP_MIN_CREDITS = envInt('CREDIT_TOPUP_MIN_CREDITS', 50);
export const CREDIT_TOPUP_MAX_CREDITS = envInt('CREDIT_TOPUP_MAX_CREDITS', 5_000);

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
