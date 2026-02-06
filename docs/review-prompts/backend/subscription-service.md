# Review Vector: Subscription Service

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- services.mdc
- security.mdc

## Scope
**Files**: `packages/lib/src/services/**`, `apps/web/src/lib/stripe*`, `apps/web/src/lib/subscription/**`, `apps/web/src/lib/billing/**`
**Level**: service

## Context
The subscription service integrates with Stripe for billing, plan management, and entitlement enforcement across the application. It handles plan transitions, trial periods, usage limits, and webhook-driven state synchronization. Review must verify that entitlement checks cannot be bypassed, billing state transitions are atomic, and Stripe API interactions follow idempotency best practices.
