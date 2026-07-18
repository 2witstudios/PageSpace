# Payment Receipt Emails Epic

**Status**: ✅ COMPLETE (2026-07-18) — reviewed, 0 blockers/majors; durable record + Findings in PageSpace `nd7ag49vwou0uxn3kx82lv1y`
**Goal**: Send a payment receipt email for every real charge to a PageSpace user — subscription renewals and one-time credit top-ups — closing the "zero billing-lifecycle emails" gap flagged in `tasks/solo-tells-audit-2026-07-17.md`.

## Overview

PageSpace charges users money in two ways (subscription renewal via `invoice.paid`, credit top-up via `checkout.session.completed`) and confirms neither by email, despite a working Resend pipeline and 20 existing react-email templates. This epic adds one new template (`PaymentReceiptEmail`, styled like `VerificationEmail` with no unsubscribe link since it's transactional) and wires a fire-and-forget send into both existing webhook branches, riding the webhook's existing `stripeEvents` idempotency gate so a Stripe redelivery can never double-send. Full design rationale, event-type evidence, and idempotency analysis live in the approved plan at `~/.claude/plans/tingly-hopping-feigenbaum.md`. Failed-payment/dunning and low-balance emails are explicitly out of scope — separate epics.

---

## Payment receipt email template

New `PaymentReceiptEmail.tsx` in `packages/lib/src/email-templates/`, following `VerificationEmail.tsx`'s structure (shared `emailStyles`, no Header/Footer components) and its no-unsubscribe precedent. Includes a dev-preview fixture (`packages/lib/emails/payment-receipt.tsx`) and a colocated render test.

**Requirements**:
- Given a receipt with no `taxFormatted`/`last4`/`invoiceUrl`, when rendered, should omit those optional lines entirely (not render empty rows).
- Given a receipt with all optional fields present, when rendered, should show the tax line, the "charged to card ending in {last4}" line, and the "view full invoice" link.
- Given the footer, should contain no unsubscribe link or `unsubscribeUrl` prop, matching `VerificationEmail`/`StepUpConfirmationEmail`.

## Payment receipt send wrapper

New `apps/web/src/lib/billing/send-payment-receipt-email.ts` exporting `sendSubscriptionReceiptEmail` and `sendTopupReceiptEmail`, following `send-verification-email.ts`'s shape: format amounts/dates, `React.createElement` the template, call `sendEmail` with `idempotencyKey: receipt:${eventId}`.

**Requirements**:
- Given an `invoice.paid` Stripe invoice, when building the receipt, should use `invoice.hosted_invoice_url` for `invoiceUrl` with no extra Stripe API call, and should never attempt to fetch last4 for this path.
- Given a credit-pack checkout session, when building the receipt, should resolve `packLabel` via `getCreditPack(metadata.packId)` (falling back to a generic label when unresolvable) and best-effort fetch last4/receipt link via `stripe.paymentIntents.retrieve(session.payment_intent, { expand: ['latest_charge'] })`, omitting both fields silently on any failure.
- Given `sendEmail` throws for any reason, should catch and log, never rethrow — callers treat this as fire-and-forget.

## Wire subscription renewal receipts into the webhook

Extend the `invoice.paid` branch in `apps/web/src/app/api/stripe/webhook/route.ts` (route.ts:175-197): broaden the existing best-effort user lookup (currently only `emitCreditsUpdated`, route.ts:184-195) to also select `name`/`email`, then call `sendSubscriptionReceiptEmail` fire-and-forget, outside `withFundingRetry`.

**Requirements**:
- Given `invoice.amount_paid === 0` (proration/trial), should not send a receipt.
- Given a fresh `invoice.paid` event, should send exactly one receipt.
- Given the dedupe outcome is `duplicate-ack` or `retry`, should never reach the receipt-send call (the `switch` never runs).
- Given the receipt-send throws, should not delete the `stripeEvents` marker and should still return 200 to Stripe.

## Wire credit top-up receipts into the webhook

Extend the `checkout.session.completed` branch (route.ts:150-169), inside the existing `mode === 'payment' && metadata.kind === 'credit_pack'` guard next to `emitCreditsUpdated` (route.ts:161-167): call `sendTopupReceiptEmail` fire-and-forget using `session.customer_details?.email` (no extra query) and one lookup by `metadata.userId` for `userName`.

**Requirements**:
- Given a fresh credit-pack `checkout.session.completed` event, should send exactly one receipt.
- Given a subscription-mode checkout session (`mode === 'subscription'`), should never call the receipt sender (that's link/provisioning only — the real charge is the following `invoice.paid`).
- Given the receipt-send throws, should not affect the webhook's 200 response or the funding that already succeeded.

---
