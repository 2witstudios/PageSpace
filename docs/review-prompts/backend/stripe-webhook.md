# Review Vector: Stripe Webhook

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc
- security.mdc

## Scope
**Files**: `apps/web/src/app/api/stripe/webhook/route.ts`, `apps/web/src/app/api/stripe/webhook/__tests__/**`
**Level**: service

## Context
The Stripe webhook endpoint receives asynchronous payment events and must verify signatures, handle event types idempotently, and synchronize billing state with the database. Webhook handlers are a critical security and data integrity surface since they drive subscription lifecycle changes. Review must confirm signature verification cannot be bypassed, event processing is idempotent against replay, and all relevant event types are handled with proper error responses.
