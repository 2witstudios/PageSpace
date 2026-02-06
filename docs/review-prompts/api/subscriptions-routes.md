# Review Vector: Subscriptions Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/subscriptions/**/route.ts`
**Level**: route

## Context
Subscription routes expose the current user's subscription status and usage metrics for the frontend to enforce feature gates and display plan information. The status endpoint returns the active plan tier, billing period, and feature entitlements. The usage endpoint returns consumption metrics like AI message counts, storage used, and member counts against plan limits. These endpoints are read-only but must accurately reflect the current Stripe subscription state and handle edge cases like expired trials, past-due invoices, and scheduled plan changes.
