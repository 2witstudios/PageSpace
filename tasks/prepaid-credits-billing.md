# Epic: Prepaid AI Credits Billing Bridge

**Status**: 📋 PLANNED
**Goal**: Ship prepaid usage-based AI billing on our own Stripe account so we can run ads and collect revenue now — without ever fronting provider cost for unpaid usage.

## Overview

We need to monetize PageSpace immediately and independently of the stalled Parallel Drive acquisition (which bundled a move to Polar), so this is a temporary bridge: a **prepaid** AI-credits model on a Stripe account we fully control. A subscription grants a **monthly credit allowance that resets each period** (use-it-or-lose-it, like the Claude model); credits are consumed at **real AI cost × 1.5**; running out means **buying more credits** (top-up packs that never expire), never a post-paid invoice. The non-negotiable rule is **we never pay a provider for AI the customer hasn't already paid for** — so Stripe's native metering (researched and rejected: it's structurally post-paid and does no real-time blocking) is used only to *collect money*, while a local two-bucket ledger is the source of truth and an app-side hard gate enforces the prepaid wall. Built **strict-TDD, RED→GREEN→REFACTOR**, with all billing decisions isolated in one **pure, zero-I/O core** (`credit-core.ts`) tested to ~100% branches and thin imperative shells over it. (The original long-form design plan was authored outside the repo; this epic file is the in-repo source of truth for scope and requirements.)

---

## Pure Core & Pricing Constants

Zero-I/O decision layer (`packages/lib/src/billing/credit-core.ts`) plus injectable constants (`credit-pricing.ts`); tests written first.

**Requirements**:
- Given a real AI cost in dollars, `markupCents` should return the ×1.5 value rounded to whole cents, including sub-cent and zero costs.
- Given a balance and a spend amount, `allocateSpend` should draw down the monthly bucket before the top-up bucket and report any shortfall.
- Given billing is disabled (tenant/onprem), `evaluateGate` should return allowed without consulting a balance.
- Given a balance whose spendable sum is at or below the reserve floor, `evaluateGate` should deny with reason `out_of_credits`.
- Given no balance row exists, `evaluateGate` should return reason `needs_init` rather than denying outright.
- Given a tier, `computeMonthlyRefill` should reset remaining to that tier's full allowance, falling back to free for an unknown tier.
- Given a current top-up balance and a pack amount, `applyTopup` should add to top-up without touching the monthly bucket and reject a negative amount.
- Given a Stripe event, `classifyStripeEvent` should map `invoice.paid`→monthly_refill, credit-pack checkout→topup, subscription tier change→tier_change, and all else→ignore.
- Given the core module, it should import no `db`, `stripe`, `env`, or `Date` — enforced by a test.

---

## Credits Schema

New `packages/db/src/schema/credits.ts` (two-bucket balances + append-only ledger); migration via `bun run db:generate`.

**Requirements**:
- Given the two-bucket model, `creditBalances` should store the resetting monthly balance and the persistent top-up balance as separate columns on one row per user.
- Given a usage event, `creditLedger` should guarantee at most one decrement per `aiUsageLogId` via a unique index.
- Given a payment event, `creditLedger` should guarantee at most one credit per `stripeRef` via a unique index.
- Given the backfill sweep, the ledger should be indexed on `(consumeStatus, createdAt)` for cheap selection of unsettled rows.

---

## Consume Path

Local decrement shell (`credit-consume.ts`) wired into `trackAIUsage`, plus the `writeAiUsage` id change. No Stripe calls.

**Requirements**:
- Given `writeAiUsage` inserts a usage row, it should return that row's id so consume has a deterministic idempotency key.
- Given a completed AI call with known cost, `consumeCredits` should decrement the balance via `allocateSpend` exactly once, even when invoked twice for the same `aiUsageLogId`.
- Given a consume failure, it should mark the ledger row `pending` and never throw into the AI request.
- Given an AI call that failed (`success:false`), `trackAIUsage` should not consume credits.
- Given the partial unique index on `aiUsageLogId` (`WHERE aiUsageLogId IS NOT NULL`), the idempotent claim insert should declare the index predicate so Postgres can infer the conflict arbiter — otherwise every insert raises `42P10` and no credits are ever consumed.
- Given no `credit_balances` row exists for the user (e.g. an existing user before the gate lazy-inits one), `consumeCredits` should leave the ledger row `pending` rather than mark it `applied`, so the charge is retried by the reconcile cron once a balance exists and is never silently dropped.

---

## Reconcile Backfill Cron

Signed-cron route (`api/cron/reconcile-credits`) over the pure `computeBackfillActions` planner.

**Requirements**:
- Given ledger rows stuck `pending`, or `aiUsageLogs` rows past the grace window with no ledger entry, the cron should apply each decrement exactly once.
- Given the reconcile run, it should call no Stripe APIs.

> **Operational follow-up (deploy repo, out of this PR's scope):** like every other cron route, `api/cron/reconcile-credits` is only a signed endpoint — the schedule lives in `PageSpace-Deploy` (`fly/fly.cron.toml` / the `pagespace-cron` image). It must be registered there for the backfill (and thus the "pending settles once a balance exists" guarantee) to actually run.

> **Retention follow-up (out of this PR's scope):** `creditLedger` currently uses `ON DELETE CASCADE` on `userId`, matching the dominant repo convention (cascade is used 136× across the schema) and the existing user-deletion flow. Because the ledger is billing provenance, a future data-retention/anonymization policy should decide whether deleting a user should instead anonymize or retain ledger rows (disputes, accounting) rather than cascade-delete them. Switching to `RESTRICT`/`NO ACTION` now would break user deletion, so it's deferred to that policy decision (likely alongside the funding task).

---

## Funding (Stripe = payment collector)

Funding shell (`credit-funding.ts`) + webhook dispatch via `classifyStripeEvent` + one-time credit-pack Checkout route.

**Requirements**:
- Given an `invoice.paid` event, `refillMonthlyAllowance` should reset the monthly bucket to the tier allowance and leave the top-up bucket untouched.
- Given a credit-pack `checkout.session.completed` (mode `payment`, metadata `kind:credit_pack`), `addTopupCredits` should add to the never-expiring top-up bucket.
- Given the same `stripeRef` twice, funding should credit the account only once.
- Given a replayed webhook event id, the handler should be a no-op via `stripeEvents` dedupe.
- Given an unknown credit-pack SKU, the purchase route should reject the checkout request.

---

## Prepaid Gate & Rate-Limit Removal

`canConsumeAI` over `evaluateGate` at each AI handler; remove per-day call counting.

**Requirements**:
- Given a user with no spendable credits, the AI route should return 402 with a buy-credits CTA instead of a 429 rate-limit error.
- Given tenant/onprem deployment, the AI route should never gate on credits.
- Given a user with no balance row, the first AI request should lazy-init the row from tier defaults before deciding.
- Given the credits model, per-day call counting (`incrementUsage`, `rate-limit-cache` wiring) should be removed from the AI path and `plans.ts` copy should advertise monthly credits.
- Given an unrecognized subscription tier, premium-model gating should deny (require upgrade) rather than grant access — gate on a positive allowlist of paid tiers, not by excluding `free`.

---

## Customer Credits Dashboard

`/settings/billing` panel + `api/subscriptions/credits` endpoint.

**Requirements**:
- Given a user's balance and recent usage, the credits endpoint should return monthly remaining/allowance/period-end, the persistent top-up balance, and a per-model spend breakdown computed at cost × 1.5.
- Given display logic, it should live in tested pure formatters rather than the component (React render tests can't run in `.pu` worktrees).

---

## Stripe Setup Script

Idempotent `apps/web/scripts/setup-stripe-credits.ts`, run against test then live keys on our own account.

**Requirements**:
- Given a fresh Stripe account, the script should idempotently create per-tier recurring subscription prices and one-time credit-pack prices.
- Given the prepaid model, the script should create no meter and no metered price.

---

## Packaging Hygiene

**Requirements**:
- Given the published `@pagespace/lib` export map, it should not advertise a `./billing/credit-funding` entrypoint until that module exists (a broken export resolves to a missing `dist` file).
