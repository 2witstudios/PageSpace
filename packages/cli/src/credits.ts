/**
 * The CLI's ONE credit formatter — a copy of the money model's `formatCreditCount`
 * (`packages/lib/src/billing/money-model.ts`, MON-5 / UI-12): cents of credit value as a
 * whole credit count with thousands separators ("900", "1,200"), never a decimal and never a
 * currency symbol; an overage keeps its minus.
 *
 * Copied rather than imported because the published CLI never runtime-imports
 * `@pagespace/lib` (`__tests__/published-entry-no-lib.test.ts`). Equality with the canonical
 * formatter is pinned by `__tests__/credits.test.ts`, which imports lib's (test-only).
 */

/** MON-4 rates (`CREDITS_PER_DOLLAR`, `CENTS_PER_DOLLAR` in the money model). */
const CREDITS_PER_DOLLAR = 100;
const CENTS_PER_DOLLAR = 100;

const creditCountFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0, useGrouping: true });

/** Pure: cents of credit value → "1,200". Multiplies before dividing, as the money model does. */
export function formatCreditCount(cents: number): string {
  const credits = Math.round((cents * CREDITS_PER_DOLLAR) / CENTS_PER_DOLLAR);
  // Math.round(-0.2) is -0, which would print as "-0".
  return creditCountFormat.format(credits === 0 ? 0 : credits);
}

/** Pure: "1,200 credits" / "1 credit". */
export function formatCredits(cents: number): string {
  const count = formatCreditCount(cents);
  return `${count} ${count === '1' ? 'credit' : 'credits'}`;
}
