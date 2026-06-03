# Epic: Credits Remediation — Review Follow-ups

Fixes for findings from the `/aidd:review` of `pu/credits-remediation`.

## Requirements (Given → Should)

### R1 [P1] Webhook unit tests must not exercise real funding
- **Given** the Stripe webhook route's unit test suite runs with billing dependencies mocked,
  **when** an `invoice.paid` or credit-pack `checkout.session.completed` event is processed,
  **should** `applyStripeFunding` be a mocked no-op (not the real module hitting a pg pool),
  the route should return 200, and the wiring (funding invoked once per funding-relevant event) should be asserted.

### R2 [P1] Resolve credit-pack buyer from trusted session metadata
- **Given** a first-time credit-pack checkout (`mode: 'payment'`) whose Stripe customer is **not** linked to a user,
  **when** top-up funding processes it,
  **should** the user be resolved from the signature-verified session `metadata.userId` (falling back to the customer lookup) and the top-up credited — never silently skipped.

### R3 [P2] Run the global-assistant credit gate before persisting the user message
- **Given** an out-of-credits user POSTs to `/api/ai/global/[id]/messages`,
  **when** the credit gate denies the request,
  **should** the 402 be returned **before** the user's message is written to the conversation (no orphaned/duplicated message on top-up + retry) — matching the page-chat route.

### R4 [P2] Exclude expired paid monthly credits from gate decisions
- **Given** a paid (non-free) user whose `monthlyPeriodEnd` is in the past (renewal invoice delayed),
  **when** the gate evaluates spendable credit,
  **should** the expired monthly bucket NOT count as spendable (only the never-expiring top-up bucket does) — i.e. blocked-until-renewal, consistent with use-it-or-lose-it. The row is not mutated (only `invoice.paid` refills paid tiers).

### R5 [P2] Base the monthly refill on the paid invoice's tier
- **Given** `invoice.paid` arrives before our DB's `users.subscriptionTier` has been updated by the subscription webhook,
  **when** the monthly refill is applied,
  **should** the allowance be computed from the tier derived from the paid invoice's line price (authoritative for the payment), falling back to the stored user tier only when the invoice carries no recognizable price.

## Out of scope (documented design, not changed)
- Review finding #2 (retry-storm on deterministic funding failure): accepted trade-off — losing paid credit is worse than redelivery noise.
- Gate lazy-init granting the paid allowance to a brand-new paid/trialing user: correct (trial entitlement); `invoice.paid` is idempotent on `stripeRef`.
