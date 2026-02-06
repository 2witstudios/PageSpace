# Review Vector: Stripe Billing Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/stripe/**/route.ts`
**Level**: route

## Context
Stripe routes manage the full billing lifecycle: subscription creation and updates, cancellation and reactivation, scheduled downgrades, promo code validation and application, payment method management via setup intents, billing portal access, invoice listing, upcoming invoice previews, billing address updates, and the Stripe webhook receiver. The webhook endpoint must verify Stripe signatures and handle idempotent event processing to prevent duplicate charges or missed state transitions. All subscription-modifying endpoints must synchronize local database state with Stripe's source of truth and handle race conditions between webhook delivery and direct API responses.
