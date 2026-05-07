# Drive Invite Follow-ups Epic

**Status**: 🔄 PARTIAL — PR 1 covers brief items #1, #2, #7 + the from-scratch architecture rebuild. PR 2 (follow-up branch) covers #3 (members UI), #4 (OAuth invite plumbing), #5 (next= plumbing), #6 (revoke endpoint).
**Goal**: Land the items deferred from PR #1267 by rebuilding invite logic into a pure-core service module with ports.

## Overview

Why: PR #1267 shipped the consent + token + accept-gateway primitives but left magic-link auto-creating users behind the new flow, post-acceptance side effects unfired on three of four entry points, pending invites invisible in the UI, OAuth (Google + Apple, all variants) blind to invite tokens, signin ignoring `next=`, and no way to revoke a pending invite. Rebuilding in a pure-core module with adapter ports collapses orchestration into one tested seam, makes side-effect omission impossible by construction, and removes the auto-create branch as a dead path.

---

## Module Scaffold

Create `packages/lib/src/services/invites/` with `types.ts`, `ports.ts`, `index.ts`.

**Requirements**:
- Given any invite-related error, should be a discriminated-union member with a string code
- Given a port consumer, should reach IO only via injected port functions

---

## Predicates

Pure boolean predicates with table-driven tests. Invite-domain predicates live in `packages/lib/src/services/invites/predicates.ts`. The URL/redirect predicate `isSafeNextPath` lives separately at `packages/lib/src/auth/safe-redirect.ts` (it is not invite-domain).

**Requirements**:
- Given a path of `/`, `//evil.com`, `/api/...`, `/auth/...`, or any URL containing `:` after the leading slash, should classify as unsafe
- Given a path beginning with `/dashboard`, `/invite/`, or `/account` (and only those prefixes), should classify as safe
- Given a `now` argument, should never read `Date.now()` internally

---

## Validators

Compose predicates into discriminated-union validators.

**Requirements**:
- Given a magic-link request for an unknown email, should return `NO_ACCOUNT_FOUND`
- Given a suspended account, should return `ACCOUNT_SUSPENDED` rather than continuing
- Given an invite whose email differs from the authenticated user's, should return `EMAIL_MISMATCH`

---

## asyncPipe Utility

Single `asyncPipe` helper that short-circuits on `{ ok: false }`.

**Requirements**:
- Given any synchronous or asynchronous step that returns `{ ok: false, ... }`, should short-circuit and propagate that result unchanged

---

## Acceptance Pipes

`acceptInviteForExistingUser` and `acceptInviteForNewUser` — asyncPipe of validate → consume → side effects → shape. Both share a single `emitAcceptanceSideEffects(ports)(payload)` step (no duplication).

**Requirements**:
- Given a successful acceptance, should fire broadcast, notification, tracking, and audit ports exactly once each
- Given any validation failure, should fire zero side-effect ports
- Given a successful new-user acceptance, should fire the same side-effect set as existing-user acceptance

---

## Revoke Pipe

`revokePendingInvite` — validate actor + drive scope, delete row, audit `authz.permission.revoked`.

**Requirements**:
- Given an `inviteId` that exists but on a different drive than the route's `driveId`, should return `NOT_FOUND` (not `FORBIDDEN`)
- Given a non-OWNER non-ADMIN actor, should return `FORBIDDEN` and not delete the row

---

## Magic-Link Pipe

`requestMagicLink` — validateAccountExists → createToken → sendEmail.

**Requirements**:
- Given an unknown email, should return `NO_ACCOUNT_FOUND` and never insert a `users` row
- Given a known email, should preserve any unrelated unconsumed tokens for that user

---

## Adapter Layer

Concrete drizzle/websocket/notifications/audit/email ports in `apps/web/src/lib/auth/`.

**Requirements**:
- Given any pipe call, should be the only place that imports drizzle, websocket, notifications, or audit modules

---

## Repository Refactor

Rename `findUserToSStatusByEmail` → `loadUserAccountByEmail`, drop `tosAcceptedAt`, add `findActivePendingInvitesByDrive`, add `deletePendingInviteForDrive`.

**Requirements**:
- Given a `deletePendingInviteForDrive` call where `inviteId` doesn't match `driveId`, should delete zero rows

---

## Email Rename

`magicLinkUrl` → `inviteUrl` in `sendPendingDriveInvitationEmail` and `DriveInvitationEmail` template.

**Requirements**:
- Given the rendered email body, should not contain the phrase "magic link"

---

## Magic-Link Service Surgical

Delete the auto-create else-branch (lines 119-153); add `NO_ACCOUNT_FOUND` to `MagicLinkError`.

**Requirements**:
- Given an unknown email passed to `createMagicLinkToken`, should return `NO_ACCOUNT_FOUND` without inserting a row

---

## Magic-Link Send Route + Form

Map `NO_ACCOUNT_FOUND` to a 404-style payload; surface in `MagicLinkForm.tsx` with a link to `/auth/signup?email=...`.

**Requirements**:
- Given an unknown email submitted, should render a CTA routing to `/auth/signup?email=<encoded>`

---

## Members Invite Route Refactor

Delete `emitJoinSideEffects`; rewire user-id path to `acceptInviteForExistingUser` pipe.

**Requirements**:
- Given a successful invite of an existing user via this route, should fire side effects via the pipe (not via in-route helper)

---

## Invite Accept Gateway Refactor

Wire `/invite/[token]/accept/route.ts` to `acceptInviteForExistingUser` via adapters.

**Requirements**:
- Given an authenticated, non-suspended user with a valid invite for their email, should land them at `/dashboard/<driveId>?invited=1`

---

## Signup-Passkey Route Refactor

Wire `signup-passkey/route.ts` to `acceptInviteForNewUser` via adapters.

**Requirements**:
- Given a passkey signup with an invite token, should fire all four side-effect ports on success

---

## OAuth State Schema + Hook + Signin Builders

Add `inviteToken` to `oauthStateDataSchema`; both signin routes forward it; `useOAuthSignIn` accepts `{ inviteToken }`.

**Requirements**:
- Given a signin request with `inviteToken` in body, should round-trip it through state into the callback

---

## Google Web Callback

Read `inviteToken` from verified state; after session decide accept-existing vs accept-new.

**Requirements**:
- Given an OAuth login that creates a new user with a valid invite, should call `acceptInviteForNewUser`
- Given an OAuth login matching an existing user with a valid invite, should call `acceptInviteForExistingUser`
- Given an invite whose email doesn't match the OAuth identity, should land with `?inviteError=EMAIL_MISMATCH` and no membership change

---

## Apple Web Callback

Same shape as Google web callback.

**Requirements**:
- Given an Apple-private-relay email that doesn't match the invite, should return `EMAIL_MISMATCH` rather than silently joining

---

## Native + One-Tap Callbacks

Google native, Google one-tap, Apple native — accept `inviteToken` in JSON body, run acceptance pipe post-session.

**Requirements**:
- Given a successful native OAuth sign-in carrying an invite token, should fire side-effect ports identically to web callback

---

## Sign Up + Sign In Clients Pass inviteToken

`SignUpClient.tsx` + `SignInClient.tsx` pass `?invite=` from query into `useOAuthSignIn`.

**Requirements**:
- Given `?invite=<token>` on either page, should be forwarded to whichever provider the user selects

---

## Members API Pending Invites Field

`GET /api/drives/[driveId]/members` returns separate `pendingInvites` array.

**Requirements**:
- Given a drive with pending invites, should return them with email, role, invitedBy display name, createdAt
- Given a non-member of the drive, should return 403

---

## Pending Invites UI Section

New `PendingInvitesSection` + `PendingInviteRow` components, owner/admin only.

**Requirements**:
- Given a non-OWNER/ADMIN viewer, should not render the section at all

---

## Members UI Cleanup

Delete `pendingMembers` filter from `DriveMembers.tsx`; remove `isPending` branch from `MemberRow.tsx`.

**Requirements**:
- Given any drive_members row, should always render as accepted (no Pending badge possible)

---

## Revoke Endpoint + Button

`DELETE /api/drives/[driveId]/pending-invites/[inviteId]/route.ts` calls `revokePendingInvite` pipe; UI button + confirm dialog.

**Requirements**:
- Given an `inviteId` belonging to a different drive, should return 404
- Given a successful revoke, should fire `authz.permission.revoked` audit with `targetEmail`

---

## next= Plumbing

`SignInClient.tsx` reads `?next=`, validates via `isSafeNextPath`, redirects after passkey signin and after magic-link verify.

**Requirements**:
- Given `next=//evil.com` or `next=javascript:...` or `next=/api/...`, should ignore and fall through to `/dashboard`
- Given `next=/dashboard/<driveId>?invited=1`, should redirect there after successful sign-in
