import { creditsFromCents } from '@pagespace/lib/billing/money-model';
import { planNameOf } from '../../settings/account-overview/account-overview-model';

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === 'object' && value !== null ? (value as Readonly<Record<string, unknown>>) : null;

/** A /api/credits amount (cents of credit value), or null when it is not a finite number. */
const cents = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Cents of credit value → the whole credit count the menu shows (MON-5: never a decimal). */
const wholeCredits = (amount: number): number => {
  const credits = Math.round(creditsFromCents(amount));
  return credits === 0 ? 0 : credits;
};

/** Whole credits with thousands separators, as the account menu writes them ("1,000"). */
export const countOf = (amount: number): string => amount.toLocaleString('en-US');

/** "Dec 3" (UTC, as the server rolls periods) for the period end, when the next allowance is added; null when there is none. */
export const grantDateLabel = (periodEnd: unknown): string | null => {
  if (typeof periodEnd !== 'string') return null;
  const date = new Date(periodEnd);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

/**
 * The credits card, in whole credits, from apps/web's GET /api/credits (which sends cents).
 * Credits roll over: each paid period ADDS the allowance to what is left (credit-core
 * computeMonthlyRefill) and top-ups never expire, so the card shows one total and what arrives
 * next, never a "left of allowance" meter or a reset.
 */
export type CreditsCard = {
  /** "Pro"; null only when the tier cannot be named. */
  readonly plan: string | null;
  /** Every credit the account can spend now: monthly carry plus top-ups, net of debt, never below 0. */
  readonly total: number;
  /** The allowance the next paid period adds, and when; null for a one-time grant or no allowance. */
  readonly nextGrant: { readonly amount: number; readonly on: string } | null;
};

/**
 * The credits card, or null when billing is off (tenant, on-prem) or the balance has not loaded:
 * the card never shows a figure the API did not send.
 */
export const creditsCardOf = (body: unknown): CreditsCard | null => {
  const root = record(body);
  if (root === null || root.billingEnabled !== true) return null;
  const monthly = record(root.monthly);
  const spendable = cents(root.spendable);
  const allowance = cents(monthly?.allowance);
  if (spendable === null || allowance === null) return null;
  const on = grantDateLabel(monthly?.periodEnd);
  const amount = wholeCredits(allowance);
  return {
    plan: planNameOf(root),
    total: wholeCredits(Math.max(0, spendable)),
    nextGrant: on !== null && amount > 0 ? { amount, on } : null,
  };
};
