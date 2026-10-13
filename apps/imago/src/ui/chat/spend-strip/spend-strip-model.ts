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
 * Where a turn is spending from. On this base only the personal balance exists, so every
 * surface spends from "Your credits"; drive wallets and seat allowances come with the orgs
 * branch (IMC-8.18). Billing off (tenant, on-prem) shows no strip at all.
 */
export const spendSourceOf = (body: unknown): SpendSource | null => {
  if (typeof body !== 'object' || body === null) return null;
  const { billingEnabled, spendable } = body as { readonly billingEnabled?: unknown; readonly spendable?: unknown };
  if (billingEnabled !== true || typeof spendable !== 'number' || !Number.isFinite(spendable)) return null;
  return { label: 'Your credits', left: `${creditsLabel(spendable)} left` };
};
