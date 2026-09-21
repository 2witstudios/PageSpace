/**
 * In-app AI-credit copy — a thin re-export of the ONE money model
 * (`@pagespace/lib/billing/money-model`, MON-1/MON-5) and the credit phrases derived
 * from it (`@pagespace/lib/billing/credit-copy`). Nothing in `apps/web` may state a
 * credit rate, an allowance, or a pack size; import from here or from those modules.
 */
export {
  creditsFromCents,
  centsFromCredits,
  creditsFromDollars,
  dollarsFromCents,
  formatCreditCount,
  formatDollars,
  creditPackPriceCents,
  validateTopupCredits,
  CREDIT_TOPUP_MIN_CREDITS,
  CREDIT_TOPUP_MAX_CREDITS,
} from '@pagespace/lib/billing/money-model';
export {
  MONTHLY_CREDIT_CENTS,
  monthlyCreditsPhrase,
  monthlyCreditsPhraseForCents,
  creditsCellPhrase,
  CREDIT_PACK_LIST,
  includedCreditsPhrase,
  includedCreditsPhraseForCents,
  topUpRatePhrase,
} from '@pagespace/lib/billing/credit-copy';

/**
 * Credit-balance explanations for the Usage card and the header tooltip.
 *
 * Where billing is hidden (the iOS app, Guideline 3.1.1) the copy states the
 * balance and when it renews, never how to buy more: no top-up, no upgrade.
 */
export function creditBalanceCopy({ isFree, showBilling }: { isFree: boolean; showBilling: boolean }): {
  description: string;
  inDebt: string;
  overage: string;
} {
  if (!showBilling) {
    return isFree
      ? {
          description: 'Credits power AI features. Your starter credits are a one-time grant.',
          inDebt: 'Your balance is below zero, so AI features are paused.',
          overage: 'Your balance is below zero.',
        }
      : {
          description: 'Credits power AI features. Your monthly allowance renews each billing period.',
          inDebt: 'Your balance is below zero until your next renewal.',
          overage: 'Overage clears at your next renewal.',
        };
  }
  return isFree
    ? {
        description:
          'Credits power AI features. Your starter credits are a one-time grant; buy top-up credits (they never expire) or upgrade for a monthly allowance.',
        inDebt: 'In the red — add credits to keep using AI.',
        overage: 'Overage clears with a top-up',
      }
    : {
        description:
          'Credits power AI features. Your monthly allowance renews each billing period; purchased top-up credits never expire.',
        inDebt: 'In the red — add credits to keep using AI (or it clears at your next renewal).',
        overage: 'Overage clears at your next renewal or with a top-up',
      };
}
