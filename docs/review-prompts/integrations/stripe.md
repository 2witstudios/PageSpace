# Review Vector: Stripe Integration

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- tdd.mdc

## Scope
**Files**: `apps/web/src/app/api/stripe/**`, `apps/web/src/lib/stripe*`, `apps/web/src/lib/billing/**`, `packages/lib/src/services/**`
**Level**: integration

## Context
The Stripe integration handles subscription management, webhook event processing, and billing state synchronization. Webhook handlers must verify Stripe signatures and process events idempotently to handle redelivery safely. Subscription state changes should propagate correctly to drive-level feature flags and user entitlements without race conditions between webhook processing and direct API responses.
