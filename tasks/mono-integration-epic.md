# PageSpace → Mono Integration Epic

**Status**: 📋 PLANNED
**Goal**: Merge PageSpace into paralleldrive-mono, migrate billing to Polar metered usage, and transition the session layer to better-auth.

## Overview

Why: PageSpace needs to share infrastructure with other Paralleldrive products. Today each product runs its own isolated stack — a custom session service, Stripe flat-tier billing, and a separate component setup. Centralising in mono lets all products share one auth server (better-auth), one billing provider (Polar with real usage metering for AI tokens, storage, and seats), and one UI library, while keeping PageSpace's authorisation layer (permissions, MCP tokens, drive scopes) exactly as-is. Tasks are ordered by dependency: the repo merge and Polar client are prerequisites for all metering and billing work; auth federation (Phase 3a) must precede the session layer swap (Phase 3b); billing route replacement is independent of the auth phases.

---

## Merge Repos

Copy all PageSpace apps and packages into paralleldrive-mono and reconcile workspace tooling.

**Requirements**:
- Given PageSpace apps/* and packages/*, should copy them into paralleldrive-mono/apps/* and packages/* and confirm `bun run build` exits 0 in CI before proceeding
- Given mono's TypeScript 6.0.3 root config and PageSpace's TS 5.8.3 requirement, should pin `"typescript": "^5.8.3"` in each migrated PageSpace app's package.json and verify `bun run --filter 'web' check:types` passes under that version — do not let TS 6 silently recompile PageSpace apps
- Given mono uses `check:lint` / `check:types` task names and PageSpace uses `lint` / `typecheck`, should add `lint` and `typecheck` aliases in the merged turbo.json so both naming conventions continue to work — do not remove or rename any existing mono tasks
- Given PageSpace's turbo.json has `db:generate`, `db:migrate`, `db:seed`, and `package` tasks absent from mono's turbo.json, should merge them additively with their original `dependsOn` and `outputs` intact
- Given the root package name is `"mono"` in paralleldrive-mono, should rename it to `"paralleldrive"` in package.json and update any Docker image labels and CI job names that reference the old name
- Given drizzle-kit is a per-app devDependency in PageSpace, should hoist it to the merged root package.json devDependencies alongside mono's existing tooling

---

## Add Polar Billing Client

Create a shared Polar client factory in packages/lib and add Polar billing columns to the database schema.

**Requirements**:
- Given `@polar-sh/sdk` v0.47.1 is already installed in apps/auth, should add it to apps/web and apps/control-plane, then export `createPolarClient({ accessToken }: { accessToken: string }): PolarClient` from packages/lib — a factory function, not a singleton, so each call site injects its own config and tests avoid shared state
- Given POLAR_ACCESS_TOKEN is absent at runtime, should export `createNoopPolarClient(): PolarClient` that satisfies the same interface but no-ops all methods and returns typed empty responses — prevents import-time crashes in local dev and onprem deployments where Polar is not configured
- Given the users table in `packages/db/src/schema/auth.ts`, should add a nullable `polarCustomerId text` column alongside the existing `stripeCustomerId` — keep both until the Polar webhook handler is live and back-filling is confirmed complete
- Given the subscriptions table in `packages/db/src/schema/subscriptions.ts`, should add a nullable `polarSubscriptionId text unique` column alongside the existing `stripeSubscriptionId` — keep both until Stripe is decommissioned
- Given schema changes, should run `bun run db:generate` to produce migrations — never hand-edit SQL in `packages/db/drizzle/`

---

## Instrument AI Token Usage Reporting

Report AI token consumption to Polar after each completed inference call.

**Requirements**:
- Given a completed AI stream, should extract token usage via a pure `buildTokenUsageEvent(usage: LanguageModelUsage): UsageIngestionEvent | null` living in `apps/web/src/lib/ai/token-reporting.ts` — returns null when `totalTokens` is 0 or undefined; the pure transform and the IO effect must be separate named exports so each is independently testable
- Given a `UsageIngestionEvent`, should send it via a side-effectful `reportTokenUsage({ event: UsageIngestionEvent, client: PolarClient }): Promise<void>` in the same file — catches and logs Polar errors without rethrowing so stream delivery never fails because of a billing error; compose with `buildTokenUsageEvent` via `asyncPipe` rather than a loose two-step sequence
- Given the `onFinish` callback already present in `apps/web/src/app/api/ai/chat/route.ts` (line ~918) and `apps/web/src/app/api/ai/global/[id]/messages/route.ts` (line ~936), should wire up the `asyncPipe(buildTokenUsageEvent, reportTokenUsage)` pipeline at those two named insertion points — no other route handlers are in scope for this task
- Given POLAR_ACCESS_TOKEN is absent, should use `createNoopPolarClient()` so `reportTokenUsage` no-ops silently without a conditional check at the call site

---

## Instrument Storage Usage Reporting

Report file storage byte deltas to Polar on upload and delete in apps/processor.

**Requirements**:
- Given an upload or delete operation, should compute the signed delta via a pure `computeStorageDelta({ operation: 'upload' | 'delete', bytes: number }): number` living in `apps/processor/src/billing/storage-reporting.ts` — positive for upload, negative for delete; this is the testable unit, keep it free of IO
- Given a `StorageIngestionEvent`, should send it via a side-effectful `reportStorageUsage({ event: StorageIngestionEvent, client: PolarClient }): Promise<void>` in the same file — catches and logs Polar errors without rethrowing; compose with `computeStorageDelta` via `asyncPipe` rather than a loose two-step sequence
- Given the upload handler at `apps/processor/src/api/upload.ts`, should wire up the pipeline only after the file is durably written and `contentHash` is returned — a failed upload must never bill
- Given the delete handler at `apps/processor/src/api/delete-file.ts`, should retrieve the file size from `contentStore.getMetadata(contentHash)` before deletion and run the pipeline after `deleteOriginalAndCache` completes — if `metadata.size` is 0 or unavailable, should skip reporting rather than ingest a zero-byte event

---

## Instrument Seat Usage Reporting

Report workspace seat count changes to Polar on drive membership transitions.

**Requirements**:
- Given a user accepts a drive invite via `apps/web/src/app/api/drives/[driveId]/pending-invites/[inviteId]/route.ts`, should ingest a `seats` event with value `+1` after the driveMembers row is committed to the DB — not before, to avoid billing a failed insert
- Given a user signs up via an invite link through `apps/web/src/app/api/auth/signup-passkey/route.ts` and `inviteAcceptedDriveId` is non-null, should also ingest a `+1` seat event after the driveMembers row is committed
- Given a user is removed via the DELETE handler in `apps/web/src/app/api/drives/[driveId]/members/[userId]/route.ts`, should ingest a `seats` event with value `-1` after the `driveMembers` delete is committed — best-effort: a Polar error must not fail the membership removal
- Given a pure `buildSeatEvent({ action: 'join' | 'leave' }): SeatIngestionEvent` function living in `apps/web/src/lib/billing/seat-reporting.ts`, should derive all ingestion payloads from it so the delta logic is testable without touching any route handler; compose with a parallel `reportSeatUsage({ event: SeatIngestionEvent, client: PolarClient }): Promise<void>` IO effect in the same file via `asyncPipe`

---

## Replace Subscription Lookups with Polar

Swap the static `subscriptionTier` column reads in subscription-utils.ts for live Polar subscription queries.

**Requirements**:
- Given a call to `getStorageConfigFromSubscription` or `subscriptionAllows`, should resolve the correct limits by querying `polarClient.subscriptions.list({ customerId })` and mapping the active subscription's product to the existing tier tiers — callers in `packages/lib/src/services/storage-limits.ts` and `apps/web/src/app/api/subscriptions/status/route.ts` must be updated to `await` the now-async signatures
- Given the same `userId` within a 60-second window, should return a cached result via an in-memory LRU cache keyed on `userId` without a Polar network call — add the cache inside the updated subscription-utils.ts module, not in the callers
- Given Polar returns a non-2xx response or times out, should return free-tier limits and log a structured error — fail closed on feature access so a Polar outage does not silently grant paid features to free users
- Given onprem or tenant deployment modes, should bypass Polar entirely and return business-tier limits — preserve the existing `isOnPrem() || isTenantMode()` guard as the first branch

---

## Replace Stripe Webhook Handler

Swap `apps/control-plane/src/routes/stripe-webhooks.ts` for a Polar webhook handler driving the same lifecycle interface.

**Requirements**:
- Given a Polar `subscription.created` or `subscription.updated` event, should update `polarSubscriptionId` and `status` on the matching subscription row and call `lifecycle.resume(slug)` when the status is `active`
- Given a Polar `subscription.revoked` or `subscription.canceled` event, should call `lifecycle.suspend(slug)` on the tenant — the same lifecycle path as the current `customer.subscription.deleted` Stripe handler
- Given a `polarEvents` table keyed on Polar's `event.id` (modelled after the existing `stripeEvents` table in `packages/db/src/schema/subscriptions.ts`), should insert the event id before processing and skip duplicate ids with a 200 response — idempotency prevents double-billing on Polar's at-least-once delivery
- Given an event with a missing or invalid `Polar-Signature` header, should return 401 — not 400, which Polar may retry indefinitely — and log the rejection without touching any DB rows
- Given an unrecognised event type, should return 200 and skip processing — matching the existing Stripe handler's no-op behaviour for unknown events

---

## Replace Billing Routes

Swap the Stripe checkout and portal routes in `apps/control-plane/src/routes/billing.ts` for Polar equivalents using `@polar-sh/sdk` directly.

**Requirements**:
- Given POST /api/billing/checkout receives `slug`, `email`, and `tier`, should create a Polar checkout session via `polarClient.checkouts.create({ productId: priceMap[tier], customerEmail: email, successUrl, cancelUrl })` and return the checkout URL — the control-plane is a server-only Fastify app; do not use the browser-facing `authClient.checkout()` from the better-auth Polar plugin
- Given POST /api/billing/portal receives `tenantSlug` with a known `polarCustomerId`, should create a Polar customer portal session via `polarClient.customerSessions.create({ customerId })` and redirect
- Given a tenant record with no `polarCustomerId`, should return 400 with a descriptive error — do not attempt a Polar API call without a customer ID
- Given Polar returns a non-2xx response, should return 502 and log the error — matching the existing Stripe error handler pattern in billing.ts
- Given the same input validation (slug, email, tier), should keep the existing `validateSlug`, `validateEmail`, and `validateTier` calls intact — only the Stripe client calls are replaced

---

## Phase 3a: Auth Federation

Deploy mono's auth app as the IDP and issue short-lived exchange codes that PageSpace redeems for its own sessions.

**Requirements**:
- Given a user completes login at auth.pagespace.ai, should redirect to app.pagespace.ai with a 30-second exchange code stored in the `authHandoffTokens` table — use the same SHA3-256-hashed, atomic `DELETE ... RETURNING` pattern from `packages/lib/src/auth/exchange-codes.ts` but with a 30-second TTL instead of 5 minutes (immediate web redirects need a shorter window than the existing desktop OAuth flow)
- Given POST /api/auth/exchange receives a valid code within the 30-second TTL, should consume it atomically via `consumeExchangeCode` and create a `ps_sess_` session using the existing `SessionService.createSession` — this is a new route distinct from the desktop exchange at `/api/auth/desktop/exchange`
- Given an expired or replayed exchange code (`DELETE ... RETURNING` returns no row), should return 401 without creating a session
- Given more than 10 exchange attempts from the same IP within 60 seconds, should return 429 using the existing rate-limit-utils.ts infrastructure
- Given existing direct-login users (magic link, passkey direct to app.pagespace.ai), should continue working unchanged throughout and after the federation cutover

---

## Phase 3b: Full Session Layer Swap

Replace `verifyAuth` to validate browser sessions via better-auth instead of the custom sessions table.

**Requirements**:
- Given a request with a `ps_sess_` cookie, should call `auth.api.getSession({ headers })` on the mono auth server and combine the result with a `users` table lookup for `role` and `tokenVersion`, then reconstruct the `VerifiedUser` interface (`id`, `role`, `tokenVersion`, `adminRoleVersion`, `authTransport`) via a pure `buildVerifiedUser({ session, dbUser }: { session: BetterAuthSession, dbUser: DbUser }): VerifiedUser` function — options object params per SDA; the pure reconstruction is the testable unit; keep it out of the route handler
- Given MCP tokens (`ps_mcp_`), service tokens (`ps_svc_`), and device tokens (`ps_dev_`), should continue validating against the existing custom sessions table — only `ps_sess_` browser cookies move to better-auth validation; all other token types are out of scope for this task
- Given the one-time cutover, should delete all rows in the sessions table where `type = 'user'` so existing `ps_sess_` cookies are rejected and users re-authenticate once via auth.pagespace.ai
- Given passkey credentials originally registered through PageSpace's custom WebAuthn flow in `packages/lib/src/auth/passkey-service.ts`, should write and pass an integration test that verifies `@better-auth/passkey` can complete an assertion ceremony using a real credential from that flow before shipping the migration — do not assert format compatibility without a passing test; this is the single highest correctness risk in the epic
