# Review Vector: Billing and Subscriptions

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc
- security.mdc

## Scope
**Files**: `apps/web/src/components/billing/**`, `apps/web/src/app/api/stripe/**`, `apps/web/src/app/api/subscriptions/**`, `apps/web/src/lib/stripe*`
**Level**: domain

## Context
Billing integrates with Stripe for subscription management, payment processing, and webhook event handling for lifecycle events like upgrades, downgrades, and cancellations. Webhook endpoints must verify Stripe signatures to prevent spoofed events, and all payment-related API routes require robust error handling to avoid leaving subscriptions in inconsistent states. The frontend billing components must accurately reflect current plan status and handle edge cases like failed payments, trial expirations, and mid-cycle plan changes.
