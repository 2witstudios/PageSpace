# Control Plane REST API Epic

**Status**: COMPLETE
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

## API Key Auth Middleware ✅

Protect all control plane endpoints with API key authentication.

**Requirements**:
- ✅ Given a request with valid `X-API-Key` header matching `CONTROL_PLANE_API_KEY` env var, should allow the request
- ✅ Given a request with missing or invalid API key, should return 401 `{ error: "Unauthorized" }`
- ✅ Given the API key, should use timing-safe comparison to prevent timing attacks
- ✅ Given the middleware, should be applied to all routes except `GET /api/health`

**Key files**:
- `apps/control-plane/src/middleware/api-key-auth.ts`
- `apps/control-plane/src/middleware/__tests__/api-key-auth.test.ts` — 7 tests

---

## Tenant CRUD Routes ✅

REST endpoints for tenant lifecycle management.

**Requirements**:
- ✅ Given POST `/api/tenants` with `{ slug, name, ownerEmail, tier }`, should validate input, trigger async provisioning, return 202
- ✅ Given GET `/api/tenants`, should return list of all tenants with status, health, and basic info
- ✅ Given GET `/api/tenants?status=active`, should filter by status
- ✅ Given GET `/api/tenants/:slug`, should return full tenant details including 20 most recent events
- ✅ Given POST `/api/tenants/:slug/suspend`, should suspend tenant, return 200 with updated tenant
- ✅ Given POST `/api/tenants/:slug/resume`, should resume tenant, return 200 with updated tenant
- ✅ Given DELETE `/api/tenants/:slug`, should trigger async destruction, return 202
- ✅ Given POST `/api/tenants/:slug/upgrade` with `{ imageTag }`, should upgrade tenant, return 200
- ✅ Given any mutation on nonexistent slug, should return 404
- ✅ Given invalid input (bad slug format, missing fields), should return 400 with validation errors
- ✅ Given a conflict (duplicate slug, invalid status transition), should return 409

**Key files**:
- `apps/control-plane/src/routes/tenants.ts`
- `apps/control-plane/src/routes/index.ts`
- `apps/control-plane/src/routes/__tests__/tenants.test.ts` — 23 tests

---

## Request/Response Schemas ✅

Input validation uses the existing `validateSlug`, `validateEmail`, `validateTier` functions from `validation/tenant-validation.ts` rather than Fastify JSON Schema. Tested implicitly through route tests.

---

## Review Fixes

Issues found during code review. Each must be addressed before merge.

### [P1] Wire production deps in index.ts ✅

**Problem**: `src/index.ts` called `createApp({ logger: true })` with no repo/engine/lifecycle, so all `/api/tenants*` routes 404'd in the live process.

**Fix**: Wired real Drizzle DB connection, tenant repository, provisioning engine, and lifecycle into `createApp()`. Requires `CONTROL_PLANE_DATABASE_URL` env var. Config paths read from env with sensible defaults.

### [P1] Don't double-create tenant in POST route ✅

**Problem**: The route called `repo.createTenant()` then fired `provision()` in background. The real provisioning engine also calls `repo.createTenant()`, so it would hit the duplicate-slug check.

**Fix**: Removed `repo.createTenant()` from the route. The engine owns tenant creation. Route validates input, checks for duplicate slug (fast-path 409), fires provision, returns 202 with `{ slug, name, ownerEmail, tier, status: 'provisioning' }`.

### [P2] Make DELETE async (fire-and-forget) ✅

**Problem**: DELETE awaited `lifecycle.destroy()` which does backup + docker compose down, blocking the response.

**Fix**: Route validates tenant exists and can transition to `destroying` (using repo + `canTransition`), then fires `lifecycle.destroy()` in background with `.catch()`, returns 202 immediately.

### [P2] Map Invalid slug errors to 400 ✅

**Problem**: `classifyError()` didn't recognize `Invalid slug` pattern, falling through to 500.

**Fix**: Added `Invalid slug` pattern to `classifyError()` → 400. Test added for invalid slug on suspend.

### [P2] Validate status query param ✅

**Problem**: `GET /api/tenants?status=bogus` passed raw value to Postgres enum → 500.

**Fix**: Validate against `VALID_STATUSES` set before querying. Return 400 for invalid values. Test added.

### [Medium] Replace `any` types ✅

**Problem**: `AppDeps` and `TenantRouteDeps` used `any` for all dependency types.

**Fix**: Defined proper typed interfaces (`TenantRouteRepo`, `ProvisioningEngine`, `Lifecycle`). `AppDeps` reuses `TenantRouteDeps` via `Partial<>`. TypeScript strict check passes.

### [Low] Use Fastify-idiomatic query parsing ✅

**Fix**: Replaced `new URL(request.url, ...)` with `request.query as Record<string, string>`.

### [Low] Auth failure logging ✅

**Fix**: Added `request.log.warn()` on auth rejection with IP address.

### [Low] Unused imports in auth test ✅

**Fix**: Removed `beforeEach` and `vi` from auth test imports.

---

## Evaluation Gate

Before moving to Epic 7:
1. Can you create a tenant via curl with an API key?
2. Can you list, get, suspend, resume, upgrade, and destroy tenants?
3. Are all error cases returning correct HTTP status codes?
4. Does `index.ts` wire real production deps so routes work at runtime?
5. Is the API contract documented enough for Epic 7 and Epic 9?
