import { formatCreditCount } from '@pagespace/lib/billing/money-model';

/** apps/web's credit balance (packages/lib billing/credit-balance.ts CreditBalanceSummary). */
export const CREDITS = '/api/credits';

/** Adds the count noun to the one money-model formatter. */
export const creditsLabel = (amount: number): string => {
  const count = formatCreditCount(amount);
  return `${count} ${count === '1' || count === '-1' ? 'credit' : 'credits'}`;
};

export type SpendSource = { readonly label: string; readonly left: string };

/**
 * The personal-only preview before a driveless conversation exists. Drive and conversation
 * sources use the wallet routes, never this balance fallback. Billing off hides this personal preview.
 */
export const spendSourceOf = (body: unknown): SpendSource | null => {
  if (typeof body !== 'object' || body === null) return null;
  const { billingEnabled, spendable } = body as { readonly billingEnabled?: unknown; readonly spendable?: unknown };
  if (billingEnabled !== true || typeof spendable !== 'number' || !Number.isFinite(spendable)) return null;
  return { label: 'Your credits', left: `${creditsLabel(spendable)} left` };
};
