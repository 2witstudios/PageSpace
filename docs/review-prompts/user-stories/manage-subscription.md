# Review Vector: Manage Subscription

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/stripe/create-subscription/route.ts`, `apps/web/src/app/api/stripe/update-subscription/route.ts`, `apps/web/src/app/api/stripe/cancel-subscription/route.ts`, `apps/web/src/app/api/stripe/webhook/route.ts`, `apps/web/src/app/api/stripe/customer/route.ts`, `apps/web/src/app/api/subscriptions/status/route.ts`, `apps/web/src/app/api/subscriptions/usage/route.ts`, `apps/web/src/components/billing/PlanCard.tsx`, `apps/web/src/components/billing/EmbeddedCheckoutForm.tsx`, `apps/web/src/components/billing/StripeProvider.tsx`, `apps/web/src/components/billing/BillingGuard.tsx`, `apps/web/src/components/billing/UsageCounter.tsx`, `packages/db/src/schema/subscriptions.ts`
**Level**: domain

## Context
The subscription journey begins when a user views their current plan in the billing UI and selects an upgrade. The PlanCard triggers a Stripe checkout session via the create-subscription API, which renders the EmbeddedCheckoutForm within the StripeProvider. After payment, the Stripe webhook route processes the event, updates the subscription record in the database, and the BillingGuard component gates features based on the new plan tier. Usage tracking via the usage API and UsageCounter component enforces limits in real-time. This flow spans Stripe API integration, webhook processing, database subscription records, frontend billing components, and feature gating logic.
