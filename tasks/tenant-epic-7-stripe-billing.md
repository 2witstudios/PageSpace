# Control Plane - Stripe Billing Integration Epic

**Status**: PLANNED
**Goal**: Automated tenant provisioning/suspension driven by Stripe subscription events

## Overview

Isolated infrastructure customers pay via Stripe at the control plane level, not inside their tenant app. This epic connects Stripe webhooks to the control plane's provisioning engine so that purchasing a plan auto-provisions a tenant, cancellation auto-suspends, and payment failure triggers warnings. The tenant app itself has billing disabled (Epic 4).

**Dependencies**: Epic 6d (control plane REST API)

---

## Standards & Rules

Read and follow these before writing any code. They apply to every task in this epic.

- **TDD Process** (`.claude/rules/tdd.mdc`): Write the test FIRST. Run it. Watch it fail. Then implement ONLY the code needed to make it pass. Repeat for each requirement. Do not write implementation before tests.
- **Test Rubric** (`.pu/templates/rubric-review.md`): Score each test file against the rubric before committing. Tests must be contract-first, mock only at boundaries, and assert observable outcomes.
- **Deferred Work Policy** (`.claude/rules/deferred-work-policy.mdc`): Complete all requirements. Update this plan if you deviate. No silent substitutions.
- **Commit Convention** (`.claude/rules/commit.mdc`): Use conventional commits (`feat:`, `fix:`, `test:`, `chore:`).
- **Pre-Merge Audit** (`.claude/rules/pre-merge-audit.mdc`): Before opening a PR, audit every requirement in this plan against your diff.

**Missing repo method**: The webhook handler references `getTenantByStripeSubscription(subscriptionId)` to look up a tenant. This method does not exist in the Epic 6b repository interface. Before implementing the webhook, add this method to `apps/control-plane/src/repositories/tenant-repository.ts` and its tests.

---

## Stripe Product & Price Setup

Define the Stripe product configuration for isolated infrastructure tiers.

**Requirements**:
- Given a Stripe product "PageSpace Isolated Infrastructure", should have metadata field `product_type=tenant_infrastructure`
- Given pricing tiers, should support at least: Standard (e.g., $199/mo) and Enterprise (e.g., $499/mo) with different resource limits
- Given the price metadata, should include `tier=standard` or `tier=enterprise` for the webhook to read
- Given a setup script (`apps/control-plane/scripts/setup-stripe-products.ts`), should idempotently create/update products and prices in Stripe

**TDD Approach**:
- Write tests for the setup script (`apps/control-plane/scripts/__tests__/setup-stripe-products.test.ts`)
- Mock the Stripe SDK
- Given Stripe product doesn't exist, should call `stripe.products.create`
- Given Stripe product already exists with matching metadata, should skip creation
- Given price creation, should include correct amount, currency, and metadata

---

## Stripe Webhook Handler

Handle Stripe webhook events to trigger tenant lifecycle actions.

**Requirements**:
- Given `checkout.session.completed` event with `tenant_infrastructure` product, should extract customer email, slug from metadata, and call provisioning engine
- Given `customer.subscription.deleted` event, should look up tenant by stripeSubscriptionId and trigger suspension
- Given `invoice.payment_failed` event with attempt count >= 3, should trigger suspension with grace period warning
- Given `invoice.payment_failed` event with attempt count < 3, should record warning event on tenant but not suspend
- Given `customer.subscription.updated` event with `status=active` (payment recovered), should resume a suspended tenant
- Given webhook signature verification failure, should return 400 and not process
- Given an unknown event type, should return 200 and ignore

**TDD Approach**:
- Write webhook handler tests (`apps/control-plane/src/routes/__tests__/stripe-webhooks.test.ts`)
- Mock `stripe.webhooks.constructEvent` to return test event payloads
- Given `checkout.session.completed` with valid metadata, should call `provisioningEngine.provision()` with extracted slug and email
- Given `customer.subscription.deleted`, should call `tenantRepository.getTenantByStripeSubscription()` then `provisioningEngine.suspend()`
- Given invalid signature, should return 400 and NOT call any provisioning methods
- Given `invoice.payment_failed` with attempt_count=1, should record event but NOT suspend

---

## Checkout Session Creation

API endpoint to initiate a Stripe checkout for new tenant subscriptions.

**Requirements**:
- Given POST `/api/billing/checkout` with `{ slug, email, tier }`, should create a Stripe checkout session
- Given the checkout session, should include `slug` in session metadata for the webhook to read
- Given the success URL, should redirect to `https://{slug}.pagespace.ai` (will show provisioning status)
- Given the cancel URL, should redirect to the marketing site
- Given slug validation, should reject slugs that are already taken
- Given slug format validation, should reject non-alphanumeric slugs, reserved words, and slugs < 3 or > 32 chars

**TDD Approach**:
- Write checkout tests (`apps/control-plane/src/routes/__tests__/checkout.test.ts`)
- Mock Stripe SDK's `checkout.sessions.create`
- Given valid input, should call Stripe with correct price_id, metadata, and URLs
- Given duplicate slug, should return 409 without calling Stripe
- Given invalid slug format, should return 400 with validation errors

---

## Billing Portal Integration

Allow existing tenant admins to manage their subscription.

**Requirements**:
- Given POST `/api/billing/portal` with `{ tenantSlug }`, should create a Stripe billing portal session
- Given the portal session, should use the tenant's `stripeCustomerId`
- Given a non-existent tenant, should return 404
- Given a tenant without stripeCustomerId, should return 400

**TDD Approach**:
- Write portal tests (`apps/control-plane/src/routes/__tests__/billing-portal.test.ts`)
- Mock Stripe SDK's `billingPortal.sessions.create`
- Given valid tenant with Stripe customer, should return portal URL
- Given tenant without Stripe customer, should return 400
