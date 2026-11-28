import { creditsFromCents } from '@pagespace/lib/billing/money-model';

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === 'object' && value !== null ? (value as Readonly<Record<string, unknown>>) : null;

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** "Dec 3" (UTC, as the server rolls periods) for the period end; null when it is not a date. */
export const grantDateLabel = (periodEnd: unknown): string | null => {
  if (typeof periodEnd !== 'string') return null;
  const date = new Date(periodEnd);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

/** What the next paid period adds, in cents of credit value, and when. */
export type NextGrant = { readonly cents: number; readonly on: string };

/**
 * The credits the next paid period will actually add, from apps/web's GET /api/credits. Credits
 * roll over: the refill adds the allowance to what is left, after paying any debt out of it first
 * (credit-core computeMonthlyRefill), so the grant is max(0, allowance - debt). Null for a free
 * tier (a one-time grant that never renews), no period end, or nothing that rounds to a credit:
 * the account menu and the Usage page never promise credits that will not arrive.
 */
export const nextGrantOf = (body: unknown): NextGrant | null => {
  const root = record(body);
  if (root === null || root.subscriptionTier === 'free') return null;
  const monthly = record(root.monthly);
  const allowance = finite(monthly?.allowance);
  const on = grantDateLabel(monthly?.periodEnd);
  if (allowance === null || on === null) return null;
  const cents = Math.max(0, allowance - Math.max(0, finite(root.debt) ?? 0));
  return Math.round(creditsFromCents(cents)) > 0 ? { cents, on } : null;
};
