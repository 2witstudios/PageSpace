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
