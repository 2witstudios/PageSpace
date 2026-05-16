# Admin Console Standalone App Epic

**Status**: ✅ COMPLETED (2026-05-16)  
**Goal**: Move the admin console out of `apps/web/` into a new standalone `apps/admin/` Next.js 15 app with its own auth, deployment surface, and trust boundary.

## Overview

The admin console lives inside the user-facing web app today, meaning the same codebase, same deployment, and same attack surface serves both regular users and privileged admin operations. Separating admin into its own Next.js app closes the privilege surface — admin is unreachable from the user-facing app, has its own login flow, and can be deployed independently (or behind a VPN). All core auth logic already lives in `packages/lib/src/auth/` and is reusable; the move is primarily about cutting the boundary and re-wiring imports, not rewriting logic.

---

## Scaffold apps/admin

Create a minimal Next.js 15 app with pnpm workspace registration, turbo pipeline entry, and base layout shell.

**Requirements**:
- Given a new app directory at `apps/admin/`, should have `package.json` referencing `@pagespace/db` and `@pagespace/lib` as workspace deps alongside Next.js 15 + shadcn/ui
- Given the monorepo root `pnpm-workspace.yaml`, should include `apps/admin` as a member
- Given `turbo.json`, should include `admin#build` and `admin#dev` in the pipeline
- Given `apps/admin/`, should have `tsconfig.json` extending the repo base config with path aliases matching the web app pattern (`@/*`)
- Given the Next.js app shell, should serve from port `3005` in dev to avoid conflicts with web (3000), realtime (3001), processor (3002)

---

## Admin Auth Layer

Create `apps/admin/src/lib/auth/` that reuses `packages/lib/src/auth/` session service and admin-role validation without duplicating logic.

**Requirements**:
- Given `apps/web/src/lib/auth/auth.ts` as a reference, should create `apps/admin/src/lib/auth/auth.ts` with `verifyAdminAuth()` and `withAdminAuth()` using the same `SessionService.validateSession()` and `validateAdminAccess()` from `packages/lib`
- Given a request with a valid session token that has `role !== 'admin'`, should return 403 and emit a `security.admin.access_denied` audit log entry
- Given a request with `adminRoleVersion` mismatch (role changed since token issued), should return 403 and log the mismatch reason
- Given `apps/admin/src/middleware.ts`, should redirect unauthenticated requests to `/login` and allow `/login`, `/api/auth/*` routes through without session check
- Given admin auth functions, should return discriminated union `{ ok: true; user: VerifiedAdminUser } | { ok: false; response: NextResponse }` rather than mixing concerns

---

## Admin Login Flow

Implement magic link login for the admin app using the same `packages/lib` magic link infrastructure the web app uses.

**Requirements**:
- Given `POST /api/auth/magic-link/send`, should validate email, call `magic-link-service.ts` from `packages/lib`, and send a magic link email pointing to the admin app's verify route
- Given `GET /api/auth/magic-link/verify?token=...`, should call `verifyMagicLinkToken()` from `packages/lib`, create a session via `SessionService.createSession()`, set the session cookie, and redirect to `/` — but return 403 if the user's `role !== 'admin'`
- Given `/login` page, should render email input form that POSTs to the send route, then show "check your email" confirmation
- Given a non-admin user who clicks a valid magic link, should see an error message (not a 500) explaining they do not have admin access

---

## Move Admin Components

Port all files from `apps/web/src/components/admin/` to `apps/admin/src/components/admin/` and update internal imports.

**Requirements**:
- Given components that import from `@/components/ui/*`, should resolve correctly via the admin app's own shadcn/ui installation
- Given `UsersTable`, `SchemaTable`, `ContactSubmissionsTable`, `CreateUserForm`, should have all component files present in the new location with no web-app-specific imports remaining
- Given the move, should NOT copy any shared `apps/web/src/components/ui/` files — install shadcn components fresh in the admin app

---

## Move Admin API Routes

Port all route handlers from `apps/web/src/app/api/admin/**` to `apps/admin/src/app/api/admin/**`, rewiring auth and DB imports.

**Requirements**:
- Given route handlers that import `withAdminAuth` from `@/lib/auth/auth`, should import it from the admin app's own `@/lib/auth/auth`
- Given route handlers that import `{ db }` from `@pagespace/db/db`, should continue to import from `@pagespace/db/db` — no change needed, same shared package
- Given all existing test files under `__tests__/` subdirectories, should move alongside their route handlers and update import paths
- Given `GET /api/admin/schema`, should continue to execute raw `db.execute(sql`...`)` PostgreSQL system queries — no abstraction layer needed

---

## Move Admin UI Pages

Port all pages and layouts from `apps/web/src/app/admin/**` to `apps/admin/src/app/**` (admin becomes the root, not a sub-path).

**Requirements**:
- Given `apps/web/src/app/admin/layout.tsx` which calls `verifyAdminAuth()` and redirects to `/dashboard`, should replace with a layout that redirects to `/login` in the admin app
- Given page components that fetch from `/api/admin/*`, should update fetch URLs to point to the admin app's own `/api/admin/*` (same-origin in the new app)
- Given monitoring, tables, global-prompt, users, audit-logs, and support pages, should all be present and functional in the admin app at their original relative paths (e.g., `/monitoring`, `/users`)
- Given `AdminLayoutClient.tsx` which provides tab navigation, should work unchanged after import path updates

---

## Remove Admin from Web App

Delete all admin routes, pages, and components from `apps/web/` and clean up orphaned auth helpers.

**Requirements**:
- Given `apps/web/src/app/admin/`, should be deleted entirely
- Given `apps/web/src/app/api/admin/`, should be deleted entirely  
- Given `apps/web/src/components/admin/`, should be deleted entirely
- Given `withAdminAuth` and `verifyAdminAuth` in `apps/web/src/lib/auth/auth.ts`, should be removed since no web-app routes use them after the move — do not leave dead exports
- Given `apps/web/middleware.ts`, should remove any admin-route-specific handling that no longer applies
- Given the web app build after deletion, should pass `pnpm typecheck` and `pnpm build` with no errors

---

## Monorepo Wiring

Wire the admin app into Docker Compose, dev scripts, and environment variable documentation.

**Requirements**:
- Given `docker-compose.yml` (or equivalent in the deploy repo), should have an `admin` service entry with its own port mapping and `DATABASE_URL` env var (pointing to the same main app DB)
- Given `pnpm dev` at the monorepo root, should start the admin app alongside web, realtime, and processor
- Given `apps/admin/.env.example`, should document required env vars: `DATABASE_URL`, `NEXTAUTH_URL` (or equivalent base URL), `EMAIL_FROM`, and any mailer config needed for magic links
- Given the admin app in CI, should run its own `pnpm typecheck` and `pnpm test` steps
