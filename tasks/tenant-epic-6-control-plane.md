# Control Plane - Tenant Registry & API Epic

**Status**: PLANNED
**Goal**: The orchestration brain that provisions, monitors, and manages isolated tenant stacks

## Overview

The control plane is a new `apps/control-plane/` app in the monorepo with its own Postgres database. It exposes a REST API for the full tenant lifecycle: create, provision, suspend, resume, upgrade, and destroy. It generates env files, runs docker compose commands, and tracks tenant state. This is the biggest epic and the core of the multi-tenant system.

**Dependencies**: Epic 4 (tenant mode), Epic 5 (compose template)

---

## Control Plane Project Scaffold

Set up the new app in the monorepo with Drizzle ORM and a REST framework.

**Requirements**:
- Given `apps/control-plane/`, should be a TypeScript Node.js app in the pnpm workspace
- Given the app, should use Drizzle ORM with its own Postgres database (`pagespace_control`)
- Given the app, should expose a REST API on port 3010
- Given the app, should have its own `package.json` with workspace dependencies on `@pagespace/lib`
- Given the pnpm workspace, should include `apps/control-plane` in `pnpm-workspace.yaml`
- Given the app, should use Fastify (lightweight, schema-validated) or Express with helmet/cors

**TDD Approach**:
- Write a health check test first (`apps/control-plane/src/__tests__/health.test.ts`)
- Given GET `/api/health`, should return `{ status: "ok", version: "..." }`
- Given the app module, should export a `createApp()` factory for test isolation
- Start the server in test setup, tear down after

---

## Control Plane Database Schema

Define the Drizzle schema for tenant metadata, events, and backups.

**Requirements**:
- Given the `tenants` table, should store: id, slug (unique), name, status (provisioning|active|suspended|destroying|destroyed), tier, stripeCustomerId, stripeSubscriptionId, ownerEmail, dockerProject, encryptedSecrets (jsonb), resourceLimits (jsonb), createdAt, updatedAt, provisionedAt, lastHealthCheck, healthStatus (healthy|unhealthy|unknown)
- Given the `tenant_events` table, should store: id, tenantId (FK), eventType, metadata (jsonb), createdAt
- Given the `tenant_backups` table, should store: id, tenantId (FK), backupPath, sizeBytes, status (pending|running|completed|failed), startedAt, completedAt
- Given slug uniqueness, should enforce unique constraint on `tenants.slug`
- Given status enum, should use a Drizzle pgEnum for type safety
- Given cascading deletes, tenant_events and tenant_backups should cascade on tenant delete

**TDD Approach**:
- Write schema tests (`apps/control-plane/src/schema/__tests__/tenants.test.ts`)
- Given the tenants schema, should have all required columns with correct types
- Given an insert with duplicate slug, should throw unique constraint error
- Given a tenant with events, deleting the tenant should cascade to events
- Use Drizzle's `db.select()` to verify column types match expectations

---

## Tenant Repository

Data access layer for tenant CRUD operations.

**Requirements**:
- Given `createTenant({ slug, name, ownerEmail, tier })`, should insert and return the tenant with status `provisioning`
- Given `getTenantBySlug(slug)`, should return the tenant or null
- Given `listTenants({ status?, tier? })`, should return filtered list
- Given `updateTenantStatus(id, status)`, should update status and timestamp
- Given `updateHealthStatus(id, healthStatus)`, should update lastHealthCheck and healthStatus
- Given `deleteTenant(id)`, should hard-delete (only called after backup + teardown)
- Given `recordEvent(tenantId, eventType, metadata)`, should insert into tenant_events

**TDD Approach**:
- Write repository tests (`apps/control-plane/src/repositories/__tests__/tenant-repository.test.ts`)
- Use a test database with Drizzle push (not migrations) for fast setup
- Each test creates its own tenant, asserts, and cleans up
- Given `createTenant` with valid data, should return object with generated id and status `provisioning`
- Given `getTenantBySlug` with nonexistent slug, should return null
- Given `listTenants` with status filter, should only return matching tenants

---

## Provisioning Engine

The core logic that provisions a new tenant stack from scratch.

**Requirements**:
- Given a provisioning request with slug and owner email, should: generate env file (Epic 5 script), write env to `tenants/{slug}/.env`, run `docker compose -p ps-{slug} up -d`, poll health until all services are healthy (timeout 120s), create initial admin user via a seed script, update tenant status to `active`, record a `provisioned` event
- Given a provisioning failure at any step, should update status to `failed`, record error event, and clean up partial resources
- Given a slug that already exists as a tenant, should reject with conflict error
- Given an invalid slug (non-alphanumeric, too long), should reject with validation error
- Given the provisioning completes, should be able to reach `https://{slug}.pagespace.ai` and get a login page

**TDD Approach**:
- Write provisioning engine tests (`apps/control-plane/src/services/__tests__/provisioning-engine.test.ts`)
- Mock the shell execution layer (docker compose calls) and the env generator
- Given valid provisioning request, should call env generator with correct slug, call docker compose up, poll health, create admin user, update status to active
- Given docker compose up failure, should update status to failed and record error event
- Given health check timeout, should update status to failed
- Test the pure validation logic (slug format, uniqueness) without mocks

---

## REST API - Tenant CRUD

API endpoints for the tenant lifecycle.

**Requirements**:
- Given POST `/api/tenants` with `{ slug, name, ownerEmail, tier }`, should create tenant and trigger async provisioning, return 202 with tenant object
- Given GET `/api/tenants`, should return list of all tenants with status and health
- Given GET `/api/tenants/:slug`, should return full tenant details including recent events
- Given POST `/api/tenants/:slug/suspend`, should stop web+realtime containers (keep postgres for data), update status to `suspended`
- Given POST `/api/tenants/:slug/resume`, should restart stopped containers, update status to `active`
- Given DELETE `/api/tenants/:slug`, should trigger async backup + teardown, return 202
- Given POST `/api/tenants/:slug/upgrade` with `{ imageTag }`, should pull new images and recreate containers
- Given all endpoints, should require API key auth via `X-API-Key` header
- Given invalid API key, should return 401

**TDD Approach**:
- Write API route tests (`apps/control-plane/src/routes/__tests__/tenants.test.ts`)
- Use the `createApp()` factory with a test database
- Mock the provisioning engine to avoid real docker calls
- Given POST `/api/tenants` with valid body, should return 202 and call provisioning engine
- Given POST `/api/tenants` with duplicate slug, should return 409
- Given GET `/api/tenants` with no auth header, should return 401
- Given POST `/api/tenants/:slug/suspend` for an active tenant, should call suspend and return 200
- Given POST `/api/tenants/:slug/suspend` for an already-suspended tenant, should return 409

---

## Admin User Seeding

After provisioning, create the initial admin user inside the tenant's database.

**Requirements**:
- Given a newly provisioned tenant, should create an admin user with the owner's email and a generated temporary password
- Given the seed script, should connect to the tenant's postgres (using the tenant's DATABASE_URL)
- Given the admin user creation, should hash the password with bcrypt
- Given the seed output, should return the temporary password so the control plane can email it
- Given an existing user with that email, should skip creation (idempotent)

**TDD Approach**:
- Write seed tests (`apps/control-plane/src/services/__tests__/admin-seeder.test.ts`)
- Mock the database connection and bcrypt
- Given valid email, should call db insert with hashed password
- Given existing user, should not insert and return existing user info
- Given bcrypt hash, should call with correct salt rounds
