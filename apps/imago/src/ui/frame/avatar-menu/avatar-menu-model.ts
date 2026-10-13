import { planNameOf } from '../../settings/account-overview/account-overview-model';

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === 'object' && value !== null ? (value as Readonly<Record<string, unknown>>) : null;

const whole = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;

/** Whole credits with thousands separators, as the account menu writes them ("1,000"). */
export const countOf = (amount: number): string => amount.toLocaleString('en-US');

/** "Nov 3" (UTC, as the server rolls periods) for the allowance's period end; null for a one-time grant that never renews. */
export const resetLabel = (periodEnd: unknown): string | null => {
  if (typeof periodEnd !== 'string') return null;
  const date = new Date(periodEnd);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

/** The credits card's figures, from apps/web's GET /api/credits. */
export type CreditsCard = {
  /** "Pro"; null only when the tier cannot be named. */
  readonly plan: string | null;
  /** "Nov 3", when the allowance renews. */
  readonly resets: string | null;
  /** Monthly credits left: the spendable total less the top-up bucket. */
  readonly left: number;
  readonly allowance: number;
  /** The monthly meter, 0 to 100. */
  readonly percent: number;
  /** Top-up credits, which never expire. */
  readonly bonus: number;
  /** Credits held by calls in flight. */
  readonly reserved: number;
};

/**
 * The credits card, or null when billing is off (tenant, on-prem) or the balance has not loaded:
 * the card never shows a figure the API did not send.
 */
export const creditsCardOf = (body: unknown): CreditsCard | null => {
  const root = record(body);
  if (root === null || root.billingEnabled !== true) return null;
  const monthly = record(root.monthly);
  const topup = record(root.topup);
  const spendable = whole(root.spendable);
  const allowance = whole(monthly?.allowance);
  const bonus = whole(topup?.remaining);
  const reserved = whole(root.reserved);
  if (spendable === null || allowance === null || bonus === null || reserved === null) return null;
  const left = spendable - bonus;
  const percent = allowance > 0 ? Math.min(100, Math.max(0, Math.round((left / allowance) * 100))) : 0;
  return {
    plan: planNameOf(root),
    resets: resetLabel(monthly?.periodEnd),
    left,
    allowance,
    percent,
    bonus,
    reserved,
  };
};
