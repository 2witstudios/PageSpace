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
 * The credits the next paid period will actually add, from apps/web's GET /api/credits: exactly
 * what credit-core's computeMonthlyRefill does to the balance. Credits roll over: the refill nets
 * any debt against the carried monthly bucket, adds the allowance, and clamps at 0, while top-ups
 * are untouched. `spendable` already nets debt, so the grant is how far the shown total moves:
 *   after = max(0, monthly.remaining - debt + allowance) + topup.remaining
 *   next  = max(0, after - max(0, spendable))
 * Null for a free tier (a one-time grant that never renews), no period end, a balance missing a
 * bucket, or nothing that rounds to a credit: the account menu and the Usage page never promise
 * credits that will not arrive.
 */
export const nextGrantOf = (body: unknown): NextGrant | null => {
  const root = record(body);
  if (root === null || root.subscriptionTier === 'free') return null;
  const monthly = record(root.monthly);
  const allowance = finite(monthly?.allowance);
  const remaining = finite(monthly?.remaining);
  const topup = finite(record(root.topup)?.remaining);
  const spendable = finite(root.spendable);
  const on = grantDateLabel(monthly?.periodEnd);
  if (allowance === null || remaining === null || topup === null || spendable === null || on === null) return null;
  const debt = Math.max(0, finite(root.debt) ?? 0);
  const after = Math.max(0, remaining - debt + Math.max(0, allowance)) + topup;
  const cents = Math.max(0, after - Math.max(0, spendable));
  return Math.round(creditsFromCents(cents)) > 0 ? { cents, on } : null;
};
