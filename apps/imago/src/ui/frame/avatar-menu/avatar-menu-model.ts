import { creditsFromCents } from '@pagespace/lib/billing/money-model';
import { planNameOf } from '../../settings/account-overview/account-overview-model';
import { nextGrantOf } from '@/lib/credits/next-grant';

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
  /** What the next paid period adds (the allowance less any debt), and when; null when nothing will arrive. */
  readonly nextGrant: { readonly amount: number; readonly on: string } | null;
};

/**
 * The credits card, or null when billing is off (tenant, on-prem) or the balance has not loaded:
 * the card never shows a figure the API did not send.
 */
export const creditsCardOf = (body: unknown): CreditsCard | null => {
  const root = record(body);
  if (root === null || root.billingEnabled !== true) return null;
  const spendable = cents(root.spendable);
  const allowance = cents(record(root.monthly)?.allowance);
  if (spendable === null || allowance === null) return null;
  const next = nextGrantOf(root);
  return {
    plan: planNameOf(root),
    total: wholeCredits(Math.max(0, spendable)),
    nextGrant: next === null ? null : { amount: wholeCredits(next.cents), on: next.on },
  };
};
