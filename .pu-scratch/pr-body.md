Wave A lane A1 — leaf q3wz8bgn7722az3wg8eadet0. Into `pu/org-wallets`, never master.

`packages/lib/src/billing/money-model.ts` is the ONE source of truth for the money model. `TIER_MONTHLY_ALLOWANCE_CENTS` and every reader are gone; `toDisplayCredits` / `formatCreditUnits(+Signed)` / `formatCreditCountSigned` are gone with their callers; the web and marketing credit modules are thin re-exports; a grep guard fails on any second conversion.

## Requirement IDs and the test that proves each

| ID | What | Test |
|---|---|---|
| MON-1 | One module defines MARKUP_BPS (moved, re-exported from credit-pricing), CREDITS_PER_DOLLAR, INCLUDED_CREDIT_RATIO_BPS; no other file states an allowance or conversion | `money-model.test.ts` "MON-1 exports MARKUP_BPS…", "MON-1 credit-pricing re-exports the SAME MARKUP_BPS", "MON-1 the ratio table is keyed by the canonical vocabulary"; `credit-pricing.test.ts` "MON-1 credit-pricing no longer tabulates an allowance"; `money-model-guard.test.ts` (all three) |
| MON-2 | allowanceCents = paidCents × ratio, derived per tier, never tabulated; computeMonthlyRefill takes the derived allowance | `money-model.test.ts` "MON-2 allowanceCentsForPaidCents = paidCents × ratio for every paid tier", "MON-2 a promo or partial period flows through", "MON-2 the free tier and an unknown tier derive nothing", "MON-2 a negative or non-finite paid amount grants nothing", "MON-2 with MONEY_MODEL_V2 off the ratio is the legacy 1:1", "MON-2 tierAllowanceCents sizes a grant from the list price… per tier", "MON-2 isMoneyModelV2Enabled reads MONEY_MODEL_V2 at call time"; `credit-core.test.ts` "MON-2 never looks a tier up…"; `credit-copy.test.ts` "MON-2 MONTHLY_CREDIT_CENTS per tier equals the list-price derivation" |
| MON-5 | One definition of a credit consumed by lib, web, marketing, admin, CLI; formatCreditCount is an integer count with thousands separators; a test greps for any second conversion | `money-model.test.ts` "MON-5 a credit is CREDITS_PER_DOLLAR⁻¹ of a dollar", "MON-5 dollarsFromCents is the single cents→dollars conversion", "MON-5 formats the canvas numbers", "MON-5 never shows decimals", "UI-12 never carries a dollar sign"; `money-model-guard.test.ts` "MON-5 no file in lib, web, marketing, admin, or cli divides or multiplies a cents/credit value by 100"; `credit-copy.test.ts` "UI-12 every credit phrase is a count" |
| MON-8 | Free starter grant is a plain credit count, not derived from a price | `money-model.test.ts` "MON-8 FREE_STARTER_CREDITS is an integer credit count", "MON-8 tierAllowanceCents(\"free\") is the starter grant in cents regardless of the flag or any price", "MON-8 an unknown/legacy tier is treated as free"; `credit-copy.test.ts` "MON-8 FREE_STARTER_CREDITS_DISPLAY is the starter count" |
| A-11 | Ratio 60% pro/business, 100 credits per dollar, Pro 900, Business 3,000 + 600 per extra seat, $10 pack = 1,000 credits | `money-model.test.ts` "A-11 CREDITS_PER_DOLLAR is 100 and INCLUDED_CREDIT_RATIO_BPS is 60%", "A-11 Pro $15 → 900 credits; Business $50 + 10 seats × $10 → 9,000 credits (Northwind Labs)", "A-11 a $10 top-up pack is 1,000 credits at the full rate" |

## Mutation check

`packages/lib/src/billing/money-model.ts:104` — `return Math.floor((paidCents * ratio) / 10_000);` changed by line index to `/ 1_000`. Five MON-2 tests in `money-model.test.ts` went red (derivation per tier, Northwind numbers, promo/partial period, legacy 1:1, tierAllowanceCents). Restored: 21/21 green.

## Judgment calls flagged in #org-wallets for the orchestrator

- `MONEY_MODEL_V2` gates only the ratio. Off = 100% of price paid, which reproduces the deleted table exactly (Pro $15 → 1500¢), so balances compute as today (Sequence Spec, "After Wave A"). The rate and the integer formatter are not gated, so a Pro balance renders "1,500 credits" where it read "15".
- A3 contract kept exactly: `INCLUDED_CREDIT_RATIO_BPS: Record<SubscriptionTier, number>`, `allowanceCentsForPaidCents(paidCents: number, tier: SubscriptionTier)`, `isMoneyModelV2Enabled(env = process.env)`.
- Founder keeps a 6000 ratio row until lane A2 removes the tier; the `Record<SubscriptionTier>` typing makes its removal a compile error here.
- Not touched (not this leaf's IDs): `CREDIT_PACKS` in credit-pricing.ts still states pack sizes in cents (MON-4); subscription-tiers.ts and the Stripe webhook are untouched (A2/A3).

## Local evidence (7 other pu agents running, so single files only; CI is the gate)

- 9 lib billing test files: 266/266 green (`money-model`, `money-model-guard`, `credit-copy`, `credit-core`, `credit-pricing`, `credit-funding`, `credit-gate`, `credit-balance`, `credits-flow.integration`).
- `bunx eslint` on every touched file from apps/web, apps/admin, apps/marketing, packages/lib: 0 errors.
- packages/lib `tsc --noEmit`: 0 errors referencing billing (the remaining errors are missing worktree deps: `@fly/sprites`, `pako`, `xlsx`…).
- Changelog entry under Unreleased › Changed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01B4uUveuc4faMTu2weLw1WC
