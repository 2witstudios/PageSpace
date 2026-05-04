# Drive Invites by Email Epic

**Status**: 📋 PLANNED
**Goal**: Let drive owners and admins invite users who don't yet have a PageSpace account, by email.

## Overview

Today's invite flow dead-ends when the invitee hasn't signed up — UserSearch only finds existing users and the empty state offers no path to actually send an invite. The schema already supports the pending-member state (`drive_members.acceptedAt` is nullable but unconditionally set to `now()`), the magic-link service already auto-creates a temp user when sent to a new email, and the `DriveInvitationEmail` template plus `notification-email-service.ts` already render and send drive-invite emails. This epic wires those pieces together so an email-payload variant of the invite route binds the new user to a pending member row, the verify route flips that row to accepted on first sign-in, and the UI gains an "Invite [email] to PageSpace" affordance plus a pending-invitations section with resend/revoke. No new table, no new route namespace, no token bookkeeping outside the existing magic-link token — pending state is `acceptedAt IS NULL`, matching the `connections.status` and `event_attendees.status` patterns already used elsewhere in the schema.

---

## Branch invite route on email payload

`POST /api/drives/[driveId]/members/invite` accepts `{ email, role, customRoleId, permissions }` in addition to the existing `{ userId, ... }` shape; new-email path resolves to a temp user via `createMagicLinkToken`, inserts a pending `drive_members` row (no `acceptedAt`), inserts page permissions, and sends `DriveInvitationEmail` with an accept link that includes `?inviteDriveId=<id>`.

**Requirements**:
- Given an email payload that maps to an existing user, should fall through to today's auto-accept add path and respond with `kind: 'added'`.
- Given an email that maps to no user, should create a pending member row whose `acceptedAt` is null and respond with `kind: 'invited'`.
- Given a re-invite of an email with an active pending row, should respond 409 with the existing member id rather than overwrite role or permissions.
- Given any email path, should normalize the email to lowercase + trimmed before lookup and storage.

---

## Auto-accept pending invitations at magic-link verify

After session creation in `apps/web/src/app/api/auth/magic-link/verify/route.ts`, look up `drive_members` rows for the authenticated user with `acceptedAt IS NULL` and atomically set `acceptedAt = now()` via a conditional UPDATE; broadcast `member_added` for each accepted row; honor `?inviteDriveId` to override the post-verify redirect.

**Requirements**:
- Given a verify request with `?inviteDriveId=X` and a matching pending row, should set `acceptedAt`, broadcast `member_added`, and redirect to `/dashboard/X`.
- Given a verify request with no `inviteDriveId` but other pending rows for that user, should still accept all of them so the user is not stranded if they sign in via a different magic link or passkey.
- Given a row whose `acceptedAt` was set concurrently, the conditional UPDATE should be a no-op and not re-broadcast.
- Given a `?inviteDriveId` that doesn't match any pending row for this user, should fall through to the default redirect rather than error.

---

## UserSearch invite-by-email affordance

`apps/web/src/components/members/UserSearch.tsx` exposes an `onInviteEmail` callback; when the query is a valid email, no results are returned, and the user is not loading, the empty state renders an "Invite [email] to PageSpace" button that calls back with the lowercased email; the invite page wires this into a branched submit that posts the email payload variant.

**Requirements**:
- Given a 2+ character query that matches an email regex with zero results, should render an invite CTA that surfaces the typed email.
- Given a 2+ character query that does not match an email regex with zero results, should render today's "no users found" message unchanged.
- Given the invite CTA is clicked, downstream role/permissions UI should treat the email the same as a selected user for the rest of the configuration flow.

---

## Members list pending section with revoke

`apps/web/src/components/members/DriveMembers.tsx` renders rows with `acceptedAt === null` in a separate "Pending invitations" group above or below the accepted-members table, with a Pending badge and a Revoke action that calls today's `DELETE /api/drives/[driveId]/members/[userId]` route.

**Requirements**:
- Given pending and accepted members co-exist for a drive, should render them in distinct visually grouped sections.
- Given a pending member row, should expose Revoke to owners and admins only and remove the row on success without a full refetch.
- Given the realtime `member_added` event fires for a previously pending row, the row should move from the pending section to the accepted section.

---

## Resend pending invitation

`POST /api/drives/[driveId]/members/[userId]/resend` re-fires `createMagicLinkToken` and `sendDriveInvitationEmail` for a pending row, rate-limited to 3 sends per row per 24 hours via `checkDistributedRateLimit`; the members UI exposes a Resend button on each pending row.

**Requirements**:
- Given a pending row, should issue a fresh magic-link token and send a new invitation email.
- Given a row with `acceptedAt` set, should respond 400 — already accepted, nothing to resend.
- Given more than 3 resend attempts on the same row within 24 hours, should respond 429.
- Given resend success, should bump `invitedAt` so the members UI can show "last sent N minutes ago" without a new column.

---
