# Control Plane REST API Epic

**Status**: PLANNED
**Goal**: HTTP endpoints for the full tenant lifecycle with API key authentication

## Overview

Wire the provisioning engine and lifecycle operations to REST endpoints. All endpoints require API key auth. Provisioning and destruction are async (return 202). This is the interface that the operational tooling (Epic 9) and Stripe billing webhooks (Epic 7) will call.

**Dependencies**: Epic 6a (app scaffold), Epic 6b (repository), Epic 6c (provisioning engine + lifecycle)

---

## Standards & Rules

Read and follow these before writing any code. They apply to every task in this epic.

- **TDD Process** (`.claude/rules/tdd.mdc`): Write the test FIRST. Run it. Watch it fail. Then implement ONLY the code needed to make it pass. Repeat for each requirement. Do not write implementation before tests.
- **Test Rubric** (`.pu/templates/rubric-review.md`): Score each test file against the rubric before committing. Tests must be contract-first, mock only at boundaries, and assert observable outcomes.
- **Deferred Work Policy** (`.claude/rules/deferred-work-policy.mdc`): Complete all requirements. Update this plan if you deviate. No silent substitutions.
- **Commit Convention** (`.claude/rules/commit.mdc`): Use conventional commits (`feat:`, `fix:`, `test:`, `chore:`).
- **Pre-Merge Audit** (`.claude/rules/pre-merge-audit.mdc`): Before opening a PR, audit every requirement in this plan against your diff.

---

## API Key Auth Middleware

Protect all control plane endpoints with API key authentication.

**Requirements**:
- Given a request with valid `X-API-Key` header matching `CONTROL_PLANE_API_KEY` env var, should allow the request
- Given a request with missing or invalid API key, should return 401 `{ error: "Unauthorized" }`
- Given the API key, should use timing-safe comparison to prevent timing attacks
- Given the middleware, should be applied to all routes except `GET /api/health`

**TDD Approach**:
- Write auth tests (`apps/control-plane/src/middleware/__tests__/api-key-auth.test.ts`)
- Given valid key, should call next/allow request
- Given missing key, should return 401
- Given wrong key, should return 401
- Given health endpoint, should not require auth

**Key files to create**:
- `apps/control-plane/src/middleware/api-key-auth.ts`

---

## Tenant CRUD Routes

REST endpoints for tenant lifecycle management.

**Requirements**:
- Given POST `/api/tenants` with `{ slug, name, ownerEmail, tier }`, should validate input, create tenant, trigger async provisioning, return 202 with tenant object
- Given GET `/api/tenants`, should return list of all tenants with status, health, and basic info
- Given GET `/api/tenants?status=active`, should filter by status
- Given GET `/api/tenants/:slug`, should return full tenant details including 20 most recent events
- Given POST `/api/tenants/:slug/suspend`, should suspend tenant, return 200 with updated tenant
- Given POST `/api/tenants/:slug/resume`, should resume tenant, return 200 with updated tenant
- Given DELETE `/api/tenants/:slug`, should trigger async destruction, return 202
- Given POST `/api/tenants/:slug/upgrade` with `{ imageTag }`, should upgrade tenant, return 200
- Given any mutation on nonexistent slug, should return 404
- Given invalid input (bad slug format, missing fields), should return 400 with validation errors
- Given a conflict (duplicate slug, invalid status transition), should return 409

**TDD Approach**:
- Write route tests (`apps/control-plane/src/routes/__tests__/tenants.test.ts`)
- Use `createApp()` factory with mocked provisioning engine and repository
- Given POST with valid body and auth, should return 202 and call provisioning engine
- Given POST with duplicate slug, should return 409
- Given GET list with no auth, should return 401
- Given POST suspend on active tenant, should return 200
- Given POST suspend on suspended tenant, should return 409
- Given DELETE, should return 202 and trigger async destroy
- Given GET /:slug for nonexistent slug, should return 404

**Key files to create**:
- `apps/control-plane/src/routes/tenants.ts`
- `apps/control-plane/src/routes/index.ts`

---

## Request/Response Schemas

Fastify JSON schemas for input validation and response serialization.

**Requirements**:
- Given POST `/api/tenants` body, should validate: slug (required, string), name (required, string), ownerEmail (required, email format), tier (required, enum)
- Given list response, should include: tenants array with id, slug, name, status, healthStatus, tier, createdAt
- Given detail response, should include: full tenant object + recentEvents array
- Given error responses, should use consistent shape: `{ error: string, details?: object }`

**TDD Approach**:
- Schema validation is tested implicitly through route tests (invalid input returns 400)
- No separate test file needed — route tests cover this

---

## Evaluation Gate

Before moving to Epic 7:
1. Can you create a tenant via curl with an API key?
2. Can you list, get, suspend, resume, upgrade, and destroy tenants?
3. Are all error cases returning correct HTTP status codes?
4. Is the API contract documented enough for Epic 7 (Stripe webhooks) and Epic 9 (operational tooling) to build against?
