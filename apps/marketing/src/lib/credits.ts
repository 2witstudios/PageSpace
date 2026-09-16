/**
 * Marketing-facing credit copy — a thin re-export of the ONE money model
 * (`@pagespace/lib/billing/money-model`, MON-1/MON-5) and the credit phrases derived
 * from it (`@pagespace/lib/billing/credit-copy`), so public pricing copy can never
 * drift from what the app meters. Do NOT hardcode a credit amount or a top-up pack
 * value anywhere in `apps/marketing`; import from here.
 */
export {
  MONTHLY_CREDITS,
  FREE_STARTER_CREDITS_DISPLAY,
  creditsPhrase,
  creditPacksPhrase,
  includedCreditsPhrase,
  topUpRatePhrase,
} from "@pagespace/lib/billing/credit-copy";
