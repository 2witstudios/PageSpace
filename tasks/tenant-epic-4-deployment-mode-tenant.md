# DEPLOYMENT_MODE=tenant App Changes Epic

**Status**: PLANNED
**Goal**: Minimal app code changes to support tenant-mode instances where billing is external and all users get max-tier features

## Overview

PageSpace currently supports `cloud` and `onprem` deployment modes. Tenant mode is a third mode where isolated instances run for paying teams. Unlike `onprem`, tenant instances are managed by the control plane. Unlike `cloud`, billing happens at the control plane level, not inside the app. All users inside a tenant instance get max-tier (business) features. This epic adds ~20 lines of code across 3 files.

---

## Deployment Mode Utilities

Add `isTenantMode()` and `isBillingEnabled()` to the deployment mode module.

**Requirements**:
- Given `DEPLOYMENT_MODE=tenant`, `isTenantMode()` should return `true`
- Given `DEPLOYMENT_MODE=cloud`, `isTenantMode()` should return `false`
- Given `DEPLOYMENT_MODE=onprem`, `isTenantMode()` should return `false`
- Given `DEPLOYMENT_MODE` is unset, `isTenantMode()` should return `false`
- Given `DEPLOYMENT_MODE=tenant`, `isCloud()` should return `false`
- Given `DEPLOYMENT_MODE=tenant`, `isOnPrem()` should return `false`
- Given `DEPLOYMENT_MODE=tenant`, `isBillingEnabled()` should return `false` (billing at control plane, not in-app)
- Given `DEPLOYMENT_MODE=cloud`, `isBillingEnabled()` should return `true`
- Given `DEPLOYMENT_MODE=onprem`, `isBillingEnabled()` should return `false`

**TDD Approach**:
- Write tests first in `packages/lib/src/__tests__/deployment-mode.test.ts`
- Use `vi.stubEnv()` to set `DEPLOYMENT_MODE` for each case
- Each assertion follows the `{ given, should, actual, expected }` pattern
- RED: write all 9 assertions, watch them fail
- GREEN: add `isTenantMode()`, update `isCloud()` to exclude tenant, add `isBillingEnabled()`
- REFACTOR: ensure no duplication

**Key file**: `packages/lib/src/deployment-mode.ts`

---

## Middleware Billing Route Blocking

Block Stripe/billing routes in tenant mode, same as onprem.

**Requirements**:
- Given `DEPLOYMENT_MODE=tenant` and a request to `/api/stripe/*`, should return 404
- Given `DEPLOYMENT_MODE=tenant` and a request to `/api/subscriptions/*`, should return 404
- Given `DEPLOYMENT_MODE=tenant` and a request to `/pricing`, should redirect to home or return 404
- Given `DEPLOYMENT_MODE=cloud` and a request to `/api/stripe/*`, should pass through normally
- Given existing onprem route blocks, should reuse the same logic (add `isTenantMode()` to the condition)

**TDD Approach**:
- Write tests in `apps/web/src/__tests__/middleware-tenant.test.ts`
- Mock `NextRequest` and assert `NextResponse` status codes
- Given tenant mode + billing route, should assert 404 response
- Given cloud mode + billing route, should assert pass-through (no redirect)

**Key file**: `apps/web/middleware.ts`

---

## Subscription Utils Max-Tier Override

Return business-tier limits for all users when running in tenant mode.

**Requirements**:
- Given `DEPLOYMENT_MODE=tenant`, `getStorageConfigFromSubscription()` should return business-tier storage limits regardless of user's subscription status
- Given `DEPLOYMENT_MODE=tenant`, AI model limits should return business-tier allowances
- Given `DEPLOYMENT_MODE=tenant`, drive member limits should return business-tier maximums
- Given `DEPLOYMENT_MODE=cloud`, should continue checking Stripe subscription status as normal

**TDD Approach**:
- Write tests in `packages/lib/src/services/__tests__/subscription-utils-tenant.test.ts`
- Mock `DEPLOYMENT_MODE=tenant` via `vi.stubEnv()`
- Given tenant mode and a free-tier user, should return business-tier storage config
- Given tenant mode and no subscription, should return business-tier limits
- Given cloud mode and a free-tier user, should return free-tier limits (existing behavior unchanged)

**Key file**: `packages/lib/src/services/subscription-utils.ts`
