/**
 * Marketing-facing credit copy — a thin re-export of the ONE money model
 * (`@pagespace/lib/billing/money-model`, MON-1/MON-5) and the credit phrases derived
 * from it (`@pagespace/lib/billing/credit-copy`), so public pricing copy can never
 * drift from what the app meters. `planFacts` is the pricing page's per-tier card
 * facts (price, included credits, top-up rate, org seat terms), the same source the
 * in-app PlanCard reads (MON-6, SEAT-2). Do NOT hardcode a credit amount or a top-up pack
 * value anywhere in `apps/marketing`; import from here.
 */
export {
  MONTHLY_CREDITS,
  FREE_STARTER_CREDITS_DISPLAY,
  creditsPhrase,
  creditPacksPhrase,
  includedCreditsPhrase,
  topUpRatePhrase,
  planFacts,
  type PlanFacts,
} from "@pagespace/lib/billing/credit-copy";
export { formatDollars } from "@pagespace/lib/billing/money-model";
