# Public Share Links Epic

**Status**: 📋 PLANNED
**Goal**: Add reusable share links for pages (Google Drive-style access) and drives (Discord-style join links), requiring sign-in to redeem, fully revocable, zero PII in the link record.

## Overview

PageSpace already has single-person email invites (`pendingInvites`, `pendingPageInvites`) — one-time tokens tied to a specific recipient. What's missing is the open-link pattern: a reusable URL that any signed-in user can redeem to join a drive or access a page. Without this, sharing content requires knowing the recipient's email upfront, making it impossible to share a link in a Slack channel, embed in a doc, or hand to a new hire. The feature is additive and complementary: email invites remain unchanged; share links are a new primitive with no email field, multi-use `isActive`/`expiresAt` lifecycle instead of `consumedAt`, and no audit trail beyond the resulting membership or permission row (GDPR: the join record IS the record). Every service function follows the zero-trust pattern from `permission-mutations.ts` — authorization is verified inside the function from an `EnforcedAuthContext`, never trusted from the call site. Business logic lives in `packages/lib/src/permissions/share-link-service.ts` as typed pure functions; route handlers are thin authenticate → parse → call → return wrappers.

---

## driveShareLinks + pageShareLinks schema

Create `packages/db/src/schema/share-links.ts` with two tables: `driveShareLinks` (`id`, `driveId`, `tokenHash`, `role`, `createdBy`, `createdAt`, `expiresAt`, `isActive`, `useCount`) and `pageShareLinks` (`id`, `pageId`, `tokenHash`, `permissions` jsonb, `createdBy`, `createdAt`, `expiresAt`, `isActive`, `useCount`). Export from schema index. Run `pnpm db:generate`.

**Requirements**:
- Given a drive or page is hard-deleted, should cascade-delete its share link rows via `ON DELETE CASCADE` on `driveId`/`pageId` — orphaned tokens cannot be replayed.
- Given the creating user is deleted, should cascade-delete their share link rows via `ON DELETE CASCADE` on `createdBy`.
- Given `useCount`, should be aggregate-only with no `redeemedBy` column — no PII trail of who redeemed.
- Given the migration is generated, should contain only `CREATE TABLE` for the two new tables and their indexes — no incidental drift on other tables.

---

## Share link service

Create `packages/lib/src/permissions/share-link-service.ts` with pure, typed functions: `createDriveShareLink`, `revokeDriveShareLink`, `listDriveShareLinks`, `redeemDriveShareLink`, `createPageShareLink`, `revokePageShareLink`, `listPageShareLinks`, `redeemPageShareLink`, `resolveShareToken`. TDD: colocated failing tests first under `__tests__/`.

**Requirements**:
- Given any create function, should verify authorization from `EnforcedAuthContext` before inserting — `createDriveShareLink` checks `isDriveOwnerOrAdmin`, `createPageShareLink` checks `canUserSharePage`.
- Given `createdBy`, should always be derived from `ctx.userId`, never accepted as a parameter.
- Given any revoke function, should re-fetch the link and verify it belongs to a drive/page the caller controls before setting `isActive = false` — never trust the `linkId` alone.
- Given `redeemDriveShareLink` is called for an already-member user, should return `{ ok: false, error: 'ALREADY_MEMBER' }` without consuming any state — idempotent.
- Given `redeemPageShareLink`, should auto-create a `driveMembers` row if the user is not yet a member — matching `pendingPageInvites` behavior.
- Given `createPageShareLink` receives `permissions` containing `'EDIT'` without `'VIEW'`, should return `{ ok: false, error: 'INVALID_PERMISSIONS' }`.
- Given token validation, should hash the raw token via `hashToken` from `token-utils.ts` and query by `tokenHash` — raw token never persisted.
- Given a token that is expired, revoked, or not found, should return `null` from `resolveShareToken` — never throw or leak which condition applied.
- Given all functions, should return discriminated `{ ok: true, data }` / `{ ok: false, error }` unions — no exceptions across boundaries.

---

## Drive share link API routes

Create `apps/web/src/app/api/drives/[driveId]/share-links/route.ts` (GET + POST) and `apps/web/src/app/api/drives/[driveId]/share-links/[linkId]/route.ts` (DELETE).

**Requirements**:
- Given `GET`, should require owner/admin auth and return active links with `id`, `role`, `useCount`, `expiresAt`, `createdAt` — never return `tokenHash`.
- Given `POST`, should accept optional `{ role, expiresAt }`, call `createDriveShareLink`, and return `{ id, shareUrl }` where `shareUrl = /s/${rawToken}` — raw token returned only here, never stored server-side after this response.
- Given `DELETE`, should call `revokeDriveShareLink` and verify the `linkId` belongs to this drive (service enforces this).
- Given Next.js 15 dynamic params, should `await context.params` before use.

---

## Page share link API routes

Create `apps/web/src/app/api/pages/[pageId]/share-links/route.ts` (GET + POST) and `apps/web/src/app/api/pages/[pageId]/share-links/[linkId]/route.ts` (DELETE).

**Requirements**:
- Given `GET`, should require `canShare` on the page and return active links with `id`, `permissions`, `useCount`, `expiresAt`, `createdAt` — never return `tokenHash`.
- Given `POST`, should default `permissions` to `['VIEW']` if omitted, call `createPageShareLink`, and return `{ id, shareUrl }` with the raw token — only at creation.
- Given `DELETE`, should call `revokePageShareLink`; service verifies ownership.
- Given Next.js 15 dynamic params, should `await context.params` before use.

---

## Token resolution + accept API

Create `apps/web/src/app/api/share/[token]/route.ts` (authenticated GET) and `apps/web/src/app/api/share/[token]/accept/route.ts` (authenticated POST).

**Requirements**:
- Given `GET /api/share/[token]`, should call `resolveShareToken` and return display info (drive name, page title, creator name, role/permissions, expiresAt) — return 404 for any invalid/expired/revoked state, opaque (same error for all failure modes).
- Given `POST /api/share/[token]/accept`, should call `redeemDriveShareLink` or `redeemPageShareLink` based on token type resolved from the hash lookup, then return `{ type: 'drive', driveId }` or `{ type: 'page', pageId, driveId }` for client-side redirect.
- Given `ALREADY_MEMBER` result from redeem, should return 200 with the drive/page coords — not an error, caller redirects normally.
- Given all write routes, should require CSRF when using session auth.

---

## Share link landing page

Create `apps/web/src/app/s/[token]/page.tsx` — a server component that renders the join/accept UI. Next.js middleware redirects unauthenticated users to sign in with `callbackUrl=/s/[token]`; no middleware change required.

**Requirements**:
- Given a drive link, should show a confirmation card with drive name, role badge, and creator name before joining — "Join [Drive]" button POSTs to accept then redirects to `/dashboard/[driveId]`.
- Given a page link, should auto-POST accept on mount (no confirmation step) then redirect to the page.
- Given any invalid/expired/revoked token, should render a generic "This link is no longer valid" card — no redirect, no leaking which failure mode.
- Given Next.js 15 dynamic params, should `await context.params` before use.

---

## Page ShareDialog UI

Update `apps/web/src/components/layout/middle-content/content-header/page-settings/ShareDialog.tsx` to show a "Share link" section when the user has `canShare`.

**Requirements**:
- Given no active link, should show a "Generate link" button and a permissions selector (View only / View + Edit).
- Given a link was just generated, should hold the raw token in React state and show a "Copy link" button — if state is lost (navigation away), show "Regenerate" which revokes-and-recreates.
- Given an active link in state, should show "Copy link" and "Revoke" — revoke calls DELETE and clears state.
- Given the user lacks `canShare`, should not render the share link section at all.

---

## Drive invite link UI

Locate the drive members/settings panel and add an "Invite link" section following the same token-in-state pattern as the page ShareDialog.

**Requirements**:
- Given no active drive link, should show "Generate link" with a role selector (Member / Admin).
- Given a link was just generated, should hold raw token in state and show "Copy link" and "Revoke".
- Given "Regenerate", should revoke the old link (DELETE) then create a new one — never expose both links simultaneously.
- Given the user is not owner/admin, should not render the invite link section.

---

## Pitfalls (carry-forward, not subtasks)

1. **Raw token is single-exposure.** Return it only in the POST create response. Never store plaintext. If the user loses it, they revoke and regenerate.
2. **`useCount` is aggregate.** Never add a `redeemedBy` or `redeemedAt` column — that creates a PII trail the GDPR requirement explicitly prohibits.
3. **Revoke verifies ownership inside the service.** Do not perform a separate ownership check in the route handler — the service is the authorization boundary (zero-trust: don't trust the call site).
4. **Page redeem auto-creates drive membership.** Matches `pendingPageInvites` behavior. If this creates a surprise membership, that's the expected UX — drive owners can always remove later.
5. **Landing page auth gate is free.** The existing middleware redirects unauthenticated users to sign in with the return URL. No new middleware rules needed.
6. **Email invites are untouched.** `pendingInvites` and `pendingPageInvites` tables and all their API routes remain unchanged. This epic is purely additive.

## Verification

- `pnpm db:generate` produces migration with only two new `CREATE TABLE` statements.
- `pnpm db:migrate` succeeds.
- `pnpm test:unit` passes including new share-link-service tests.
- Drive share link: generate → copy → new-user session → `/s/[token]` → join → confirm user appears in `drive_members` with correct role.
- Drive share link: revoke → `/s/[token]` → generic "no longer valid" card, no membership created.
- Page share link: generate → copy → different signed-in user → visits `/s/[token]` → auto-accepted → lands on page with `canView`.
- GDPR check: `drive_share_links` row has no `redeemedBy`; `drive_members` row is the only record of the join.
- Zero-trust check: non-admin user attempts to revoke a drive share link → 403.
- `pnpm typecheck` — no errors.
