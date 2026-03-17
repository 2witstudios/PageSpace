# Control Plane Scaffold & Schema Epic

**Status**: PLANNED
**Goal**: A new `apps/control-plane/` app in the monorepo with Drizzle schema, migrations, and a health check endpoint

## Overview

Foundation layer for the control plane. Get the app compiling, a health check passing, and the database schema defined with migrations. Everything else in the control plane builds on this.

**Dependencies**: None (monorepo patterns already established)

---

## App Scaffold

Set up the new app in the monorepo with a REST framework and test harness.

**Requirements**:
- Given `apps/control-plane/`, should be a TypeScript Node.js app in the pnpm workspace
- Given the app, should expose a REST API on port 3010
- Given the app, should have its own `package.json` with workspace dependency on `@pagespace/lib`
- Given the pnpm workspace, `apps/*` wildcard already includes it — verify it resolves
- Given the app, should use Fastify (lightweight, schema-validated, good test story via `app.inject()`)
- Given the app module, should export a `createApp()` factory for test isolation
- Given `pnpm dev`, the control plane should NOT start automatically (it's infrastructure, not user-facing) — add a separate `pnpm --filter control-plane dev` script
- Given the app, should have its own `vitest.config.ts` and `tsconfig.json`

**TDD Approach**:
- Write a health check test first (`apps/control-plane/src/__tests__/health.test.ts`)
- Given GET `/api/health`, should return `{ status: "ok", version: "..." }`
- Given the `createApp()` factory, should return a Fastify instance that can be injected into without starting a real server

**Key files to create**:
- `apps/control-plane/package.json`
- `apps/control-plane/tsconfig.json`
- `apps/control-plane/vitest.config.ts`
- `apps/control-plane/src/app.ts` (createApp factory)
- `apps/control-plane/src/index.ts` (entrypoint)

---

## Database Schema

Define the Drizzle schema for tenant metadata, events, and backups.

**Requirements**:
- Given the control plane, should use its own Postgres database (`pagespace_control`), NOT the main app database
- Given the `tenants` table, should store: id (uuid), slug (unique), name, status (provisioning|active|suspended|destroying|destroyed), tier, stripeCustomerId, stripeSubscriptionId, ownerEmail, dockerProject, encryptedSecrets (jsonb), resourceLimits (jsonb), createdAt, updatedAt, provisionedAt, lastHealthCheck, healthStatus (healthy|unhealthy|unknown)
- Given the `tenant_events` table, should store: id (uuid), tenantId (FK), eventType, metadata (jsonb), createdAt
- Given the `tenant_backups` table, should store: id (uuid), tenantId (FK), backupPath, sizeBytes, status (pending|running|completed|failed), startedAt, completedAt
- Given slug uniqueness, should enforce unique constraint on `tenants.slug`
- Given status and healthStatus, should use Drizzle pgEnum for type safety
- Given cascading deletes, tenant_events and tenant_backups should cascade on tenant delete
- Given migrations, should be generated via Drizzle Kit (`drizzle-kit generate`) into `apps/control-plane/drizzle/`

**TDD Approach**:
- Write schema structure tests (`apps/control-plane/src/schema/__tests__/tenants.test.ts`)
- Given the tenants schema, should have all required columns with correct types
- Given the status enum, should include all valid statuses
- Given the healthStatus enum, should include healthy|unhealthy|unknown
- Test schema exports and column definitions (no DB connection needed for structural tests)

**Key files to create**:
- `apps/control-plane/src/schema/tenants.ts`
- `apps/control-plane/src/schema/tenant-events.ts`
- `apps/control-plane/src/schema/tenant-backups.ts`
- `apps/control-plane/src/schema/index.ts`
- `apps/control-plane/drizzle.config.ts`

---

## Evaluation Gate

Before moving to Epic 6b:
1. Does `pnpm --filter control-plane dev` start the server on port 3010?
2. Does the health check return 200?
3. Do schema tests pass?
4. Do migrations generate cleanly?
5. Does the app follow existing monorepo patterns (realtime, processor)?
