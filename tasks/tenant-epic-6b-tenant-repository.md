# Tenant Repository & Validation Epic

**Status**: IN PROGRESS
**Goal**: Data access layer for tenant CRUD with input validation and status transition logic

## Overview

The repository is the seam between the control plane's business logic and the database. All tenant state changes go through here. Includes slug validation, status transition rules, and event recording.

**Dependencies**: Epic 6a (schema must exist)

---

## Standards & Rules

Read and follow these before writing any code. They apply to every task in this epic.

- **TDD Process** (`.claude/rules/tdd.mdc`): Write the test FIRST. Run it. Watch it fail. Then implement ONLY the code needed to make it pass. Repeat for each requirement. Do not write implementation before tests.
- **Test Rubric** (`.pu/templates/rubric-review.md`): Score each test file against the rubric before committing. Tests must be contract-first, mock only at boundaries, and assert observable outcomes.
- **Deferred Work Policy** (`.claude/rules/deferred-work-policy.mdc`): Complete all requirements. Update this plan if you deviate. No silent substitutions.
- **Commit Convention** (`.claude/rules/commit.mdc`): Use conventional commits (`feat:`, `fix:`, `test:`, `chore:`).
- **Pre-Merge Audit** (`.claude/rules/pre-merge-audit.mdc`): Before opening a PR, audit every requirement in this plan against your diff.

---

## Tenant Repository

Data access layer for tenant CRUD operations.

**Requirements**:
- Given `createTenant({ slug, name, ownerEmail, tier })`, should insert and return the tenant with status `provisioning`
- Given `getTenantBySlug(slug)`, should return the tenant or null
- Given `getTenantById(id)`, should return the tenant or null
- Given `listTenants({ status?, tier? })`, should return filtered list with pagination
- Given `updateTenantStatus(id, status)`, should update status and updatedAt timestamp
- Given `updateHealthStatus(id, healthStatus)`, should update lastHealthCheck to now and healthStatus
- Given `deleteTenant(id)`, should hard-delete (only called after backup + teardown)
- Given `recordEvent(tenantId, eventType, metadata)`, should insert into tenant_events
- Given `getRecentEvents(tenantId, limit)`, should return most recent events ordered by createdAt desc

**TDD Approach**:
- Write repository tests (`apps/control-plane/src/repositories/__tests__/tenant-repository.test.ts`)
- Mock the Drizzle db instance — do NOT connect to a real database in unit tests
- Given `createTenant` with valid data, should call db.insert with correct values and return object with status `provisioning`
- Given `getTenantBySlug` with nonexistent slug, should return null
- Given `listTenants` with status filter, should pass filter to where clause
- Given `recordEvent`, should insert with correct tenantId and eventType

**Key files to create**:
- `apps/control-plane/src/repositories/tenant-repository.ts`
- `apps/control-plane/src/repositories/index.ts`

---

## Input Validation

Pure validation functions for tenant inputs.

**Requirements**:
- Given a slug, should validate: lowercase alphanumeric + hyphens only, 3-63 chars, starts/ends with alphanumeric, no consecutive hyphens
- Given a reserved slug (www, api, app, admin, mail, ftp, traefik, status), should reject
- Given an ownerEmail, should validate basic email format
- Given a tier, should validate against allowed values (free, pro, business, enterprise)

**TDD Approach**:
- Write validation tests (`apps/control-plane/src/validation/__tests__/tenant-validation.test.ts`)
- Pure functions, no mocks needed
- Given "my-tenant", should be valid
- Given "MY_TENANT", should be invalid (uppercase, underscore)
- Given "a", should be invalid (too short)
- Given "www", should be invalid (reserved)
- Given "-starts-with-hyphen", should be invalid

**Key files to create**:
- `apps/control-plane/src/validation/tenant-validation.ts`

---

## Status Transitions

State machine for tenant lifecycle.

**Requirements**:
- Given valid transitions: provisioning->active, provisioning->failed, active->suspended, suspended->active, active->destroying, suspended->destroying, destroying->destroyed, failed->destroying
- Given an invalid transition (e.g., destroyed->active), should throw
- Given the transition rules, should be a pure function `canTransition(from, to): boolean`

**TDD Approach**:
- Write transition tests (`apps/control-plane/src/validation/__tests__/status-transitions.test.ts`)
- Test every valid transition returns true
- Test representative invalid transitions return false
- Pure function, no mocks

**Key files to create**:
- `apps/control-plane/src/validation/status-transitions.ts`

---

## Evaluation Gate

Before moving to Epic 6c:
1. Can you create, read, update, and delete tenants through the repository?
2. Does slug validation catch all edge cases?
3. Are status transitions enforced?
4. Is the repository mockable for the provisioning engine tests?
