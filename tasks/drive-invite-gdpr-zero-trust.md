# Drive Invites GDPR + Zero-Trust Epic

**Status**: 📋 PLANNED
**Goal**: Stop creating `users` rows at invite-send time; route invitees through standard signup/login with affirmative ToS acceptance and zero-auth-power tokens.

## Overview

Drive invites currently auto-create a `users` row when the inviter sends — before the invitee has clicked anything, seen a privacy policy, or consented (`apps/web/src/app/api/drives/[driveId]/members/invite/route.ts:407` → `packages/lib/src/auth/magic-link-service.ts:124-131`) — and the resulting 7-day magic-link is the *sole* credential to claim that pre-baked account, silently bypassing passkeys for users who already have one. That violates GDPR Art. 6 lawful basis and Art. 13 transparency (a persistent identity is processed before the data subject does anything that constitutes consent), violates zero-trust (URL possession = identity = full session, no passkey check), and breaks the UX expectation set by Slack/Notion/Linear/Google Drive (none auto-create accounts; all route invites through standard signup/login with a consent gate). The fix moves pending state into a dedicated `pendingInvites` table, makes the invite token a page-load credential with no auth power, sends invitees through `/invite/[token]` (consent screen) → `/auth/signup?invite=<token>` (real ToS checkbox, locked email) for new users or `/invite/[token]/accept` (session check) for existing users, and consumes the invite via Eric-Elliott-style `asyncPipe(validate → consume → grant)` only after a real session is minted. Hard cutover per project convention (no backwards-compat for unreleased features) — including deletion of the broad-sweep `acceptUserPendingInvitations` helper, its 9 auth-route call-sites, the resend route, and dead UI bits. `magic-link-service.ts` itself is left untouched (passkey + magic-link signup is the gold-standard duo); only the orphaned `INVITATION_LINK_EXPIRY_MINUTES` constant is removed once its last importer is deleted. This PR supersedes #1266; the architecture is identical, the scope is clean.

---

## pendingInvites schema

Add a `pendingInvites` table in `packages/db/src/schema/pending-invites.ts` with `id`, `tokenHash`, `email`, `driveId`, `role`, `invitedBy`, `expiresAt`, `consumedAt`, `createdAt`. Wire it into `packages/db/src/schema.ts` (barrel + namespace) and `packages/db/package.json` exports. Generate the migration via `pnpm db:generate`.

**Requirements**:
- Given a drive is hard-deleted, should cascade-delete its `pendingInvites` rows so abandoned tokens cannot be replayed against re-created drives sharing an id.
- Given two unconsumed invites are sent for the same `(driveId, email)` pair, should reject the second at the DB level via a partial unique index `(drive_id, email) WHERE consumed_at IS NULL` — not just in application code.
- Given the migration is generated, should contain only one `CREATE TABLE` and the partial index — no incidental drift on `drive_members` or other tables.

---

## Pure invite predicates

Create `packages/lib/src/services/invite-predicates.ts` exporting `isInviteExpired({ expiresAt, now })`, `isInviteConsumed({ consumedAt })`, `isEmailMatchingInvite({ inviteEmail, userEmail })`. TDD: failing tests first, colocated under `__tests__/`.

**Requirements**:
- Given `userEmail` differs from `inviteEmail` only by case or surrounding whitespace, should return `true` from `isEmailMatchingInvite` (normalize both to trimmed lowercase) — same normalization the invite endpoint already applies via Zod.
- Given `now` exactly equals `expiresAt` (boundary), should return `true` from `isInviteExpired` — and the cases 1ms before and 1ms after should each be tested explicitly.
- Given the predicates, should be pure functions with destructured object args (SDA), no DB or `Date.now()` calls inside — `now` is injected.

---

## Invite token primitive

Create `createInviteToken({ now, expiryMinutes? })` in `packages/lib/src/auth/invite-token.ts` returning `{ token, tokenHash, expiresAt }`, plus `verifyInviteToken({ token, tokenHash })`. Default expiry 48h; reuse `generateToken('ps_invite')` + `hashToken` from `token-utils.ts`.

**Requirements**:
- Given the existing SHA3-256 hash helper exists at `packages/lib/src/auth/token-utils.ts`, should reuse it rather than introducing a second hashing primitive.
- Given the function returns `tokenHash`, should never persist or log the raw `token` — only the hash lives at rest.
- Given verification, should compare via `secureCompare` (timing-safe) rather than direct string equality.

---

## pendingInvites repository

Add CRUD to `apps/web/src/lib/repositories/drive-invite-repository.ts`: `createPendingInvite`, `findPendingInviteByTokenHash` (joined with drive name + inviter name), `markInviteConsumed` (atomic `WHERE consumedAt IS NULL`), `deletePendingInvite`, `findActivePendingInviteByDriveAndEmail` (filters `expiresAt > now AND consumedAt IS NULL`), `findUserToSStatusByEmail`, and a transactional `consumeInviteAndCreateMembership({ inviteId, driveId, userId, role, invitedBy, acceptedAt })`. The legacy `findPendingMembersForUser`/`acceptPendingMember`/`bumpInvitedAt` are left in place here — they are deleted in a later task.

**Requirements**:
- Given an attempt to consume an already-consumed invite, should return `{ reason: 'TOKEN_CONSUMED' }` (no rows updated) via the conditional `WHERE consumedAt IS NULL` UPDATE — atomic single-use, no read-then-write race.
- Given `findPendingInviteByTokenHash` returns the row, should also return `drive.name` + `inviter.name` so the consent page renders in a single query (no N+1).
- Given `consumeInviteAndCreateMembership`, should run the conditional consume + `driveMembers` insert in a **single Drizzle transaction** so a crash mid-pipe cannot consume the token without granting the membership; rollback the consume if the insert raises.
- Given an expired-unconsumed row exists for `(driveId, email)`, should sweep-delete it inside the transaction before insert so the partial unique index does not block legitimate re-invites of an expired prior token.

---

## Rewrite invite endpoint

In `apps/web/src/app/api/drives/[driveId]/members/invite/route.ts`, replace the `createMagicLinkToken` + `createDriveMember(acceptedAt: null)` pair in `handleEmailPath` with `createInviteToken` + `createPendingInvite`. The verified-existing-user fast path (`handleUserIdPath`) is unchanged. Email URL becomes `${appUrl}/invite/${rawToken}`.

**Requirements**:
- Given the email send fails after `pendingInvites` row was created, should roll back via `deletePendingInvite` (mirror the existing rollback semantics).
- Given a unique-constraint violation surfaces from a concurrent re-invite race, should return `409 already pending` (the active-pending pre-check eliminates the common case; this only catches the narrow race window).
- Given the email path no longer creates a `users` row, should drop the `logMemberActivity` call on this path — there is no `targetUserId`; `auditRequest` already records the `targetEmail`.
- Given an unverified existing `users` row exists for the email (orphan from a prior revoked invite), should treat as a new-invite path (route through `pendingInvites`); the orphan `users` row is wiped by the data-migration task before deploy.

---

## /invite/[token] consent page

New `apps/web/src/app/invite/[token]/page.tsx` server component plus `apps/web/src/lib/auth/invite-resolver.ts` exporting `resolveInviteContext({ token, now })`. The page renders inviter name, drive name, role, the invited email (read-only), ToS+Privacy summary, and a single CTA — "Create account & join" → `/auth/signup?invite=<token>` for new users, "Sign in to join" → `/invite/<token>/accept` for existing users (`isExistingUser` is `true` when the invited email maps to a user with `tosAcceptedAt IS NOT NULL`).

**Requirements**:
- Given the token is invalid, expired, or consumed, should render an opaque "this invite is no longer valid" page — never redirect (would leak that an invite ever existed for that token).
- Given Next.js 15 makes `params` a `Promise`, should `await context.params` — direct destructuring is a silent runtime bug.
- Given the page resolves the token to determine `isExistingUser`, should not disclose any other PII about the existing user (no name, no last-login) — only that this email already has an account.
- Given `resolveInviteContext` returns `{ ok: false, error }`, should use a discriminated union for the error code (`NOT_FOUND` | `EXPIRED` | `CONSUMED`) rather than throwing across boundaries.

---

## /invite/[token]/accept gateway + acceptance pipes

New `apps/web/src/app/invite/[token]/accept/route.ts` (GET handler) plus `apps/web/src/lib/auth/invite-acceptance.ts` exporting `acceptInviteForExistingUser` and `acceptInviteForNewUser` as `asyncPipe(validateInviteToken → validateEmailMatchesInvite → consumeInviteAndCreateMembership)`. The route uses `authenticateRequestWithOptions({ allow: ['session'] })`.

**Requirements**:
- Given the request has no session, should redirect to `/auth/signin?invite=<token>&next=/invite/<token>/accept` — the post-signin two-click fallback is acceptable for this PR (`next=` plumbing is a separate task).
- Given the authenticated user's email does not match `pendingInvites.email`, should return `EMAIL_MISMATCH` and redirect to `/dashboard?inviteError=EMAIL_MISMATCH` — token possession alone never grants membership.
- Given any pipe step returns `{ ok: false }`, should not throw — boundaries convert the result into a structured redirect (`/dashboard?inviteError=<code>`); on success redirect to `/dashboard/<driveId>?invited=1`.
- Given `acceptInviteForExistingUser` checks `findExistingMember` before consuming, should return `ALREADY_MEMBER` if the user is already accepted into the drive — without consuming the token (so the inviter can see they were already added rather than burning the token).

---

## Wire ?invite= into signup flow + ToS checkbox

Convert `apps/web/src/app/auth/signup/page.tsx` to a server component that resolves `?invite=<token>` via `resolveInviteContext` and passes `inviteContext` + `inviteToken` to a new `SignUpClient.tsx` (the existing `CloudSignUp` body, extracted). Replace the hardcoded `acceptedTos: true` at `PasskeySignupButton.tsx:111` with a real checkbox above the submit button. Add `lockedEmail` and `inviteToken` props to `PasskeySignupButton`. Remove the duplicate "By signing up..." footer text from the signup page (the checkbox replaces it). Wire `acceptInviteForNewUser` into `apps/web/src/app/api/auth/signup-passkey/route.ts` via an optional `inviteToken` field on the zod schema.

**Requirements**:
- Given a user submits the form without checking ToS, should block submission client-side AND server-side — server-side validation already exists at `signup-passkey/route.ts:28` (`acceptedTos: z.boolean().refine(val => val === true)`); client must enforce it too.
- Given `lockedEmail` is provided, should render the email input as `disabled` (not just `readOnly`) and prefilled — server re-validates on submit.
- Given `acceptInviteForNewUser` runs after session creation and fails, should NOT revoke the session — signup remains successful, the dashboard surfaces `?inviteError=<code>` (invite acceptance is non-fatal to signup).
- Given `acceptInviteForNewUser` succeeds, should override the getting-started provisioning redirect and land the user on `/dashboard/<driveId>?welcome=true`.

---

## Delete broad-sweep helper + 9 auth-route callers

Hard cutover per project rule. Delete `apps/web/src/lib/auth/post-login-pending-acceptance.ts` + its colocated test. Remove the `import` and `try/catch` block calling `acceptUserPendingInvitations(userId)` from each of the 9 auth routes (apple/native, apple/callback, magic-link/verify, passkey/authenticate, google/native, google/one-tap, google/callback, signup-passkey, mobile/oauth/google/exchange) — and remove the corresponding mocks/assertions from each route's `__tests__/route.test.ts`. Delete `apps/web/src/app/api/auth/__tests__/post-login-acceptance-coverage.test.ts` (the gate test is moot once the function is gone). Delete the now-orphaned `findPendingMembersForUser`, `acceptPendingMember`, and `bumpInvitedAt` methods from `drive-invite-repository.ts`.

**Requirements**:
- Given a normal login (no `?invite=`), should NOT run any pending-invite query — pending state lives in `pendingInvites` keyed on email/token; broad userId-keyed sweeps are the structural cause of the original GDPR/zero-trust problem and must not return.
- Given grep across the worktree, should yield **zero** remaining references to `acceptUserPendingInvitations`, `findPendingMembersForUser`, `acceptPendingMember`, or `bumpInvitedAt` after this task — any leftover callsite means the cleanup is incomplete.
- Given existing route tests import the broad-sweep helper as a mock, should be updated to drop the mock + the assertion in the same task (no separate "fix tests later" follow-up).

---

## Delete resend route + UI

Delete `apps/web/src/app/api/drives/[driveId]/members/[userId]/resend/route.ts` and any colocated test. Remove `handleResendInvitation` and the `onResend` prop pass-through from `apps/web/src/components/members/DriveMembers.tsx`. Remove the `onResend` prop and the Resend button JSX from `apps/web/src/components/members/MemberRow.tsx`. After the deletions, grep for `INVITATION_LINK_EXPIRY_MINUTES`; if zero callers remain, delete the constant from `packages/lib/src/auth/magic-link-service.ts:23`.

**Requirements**:
- Given the resend route was keyed on `userId` (the pre-baked `users` row from the old flow), should be deleted rather than reworked — the new model keys pending state on `(driveId, email)` in `pendingInvites`, and resend is correctly served by the inviter sending a fresh invite via the rewritten endpoint.
- Given `INVITATION_LINK_EXPIRY_MINUTES` was only consumed by the resend route and the rewritten invite endpoint (which now uses `createInviteToken`'s 48h default), should be removed — its `60*24*7` value is no longer correct policy and leaving it is a footgun for future callers.
- Given `magic-link-service.ts` is the gold-standard zero-trust passwordless surface, should be touched **only** to delete the orphaned constant — the `createMagicLinkToken` body and `verifyMagicLinkToken` body remain unchanged in this PR.

---

## One-shot pending_invites data migration

Create `packages/db/src/migrate-pending-invites.ts` (TypeScript script run via `tsx`) with header comment "Run BEFORE deploying the new code." The script (1) deletes all `drive_members` rows with `acceptedAt IS NULL`, (2) deletes orphan `users` rows where `provider='email' AND tosAcceptedAt IS NULL AND emailVerified IS NULL` AND no passkeys AND no remaining `drive_members` rows, (3) emits the wiped `(driveId, email)` pairs to stdout so admins can re-invite via the new flow. Add `migrate-pending-invites` to `packages/db/package.json` scripts. Idempotent.

**Requirements**:
- Given the original raw invite token was never persisted (the legacy magic-link flow stored only the hash on `verificationTokens`), should NOT attempt to port pending rows into `pendingInvites` with a fabricated token — the migrated row would be unusable AND would trip the partial unique index on legitimate re-invites.
- Given a `users` row created by the old invite path has any linked content beyond a pending `drive_members` row (page authorship, comments, sessions, anything), should NOT be deleted — only true orphans go.
- Given the script is run twice in a row, should produce the same end state on the second run (zero additional deletions, exit 0) — idempotent by precondition (the WHERE clauses naturally select empty sets after the first run).
- Given the script writes only `DELETE` statements, should run inside a single transaction so a partial failure leaves the DB in a consistent state.

---

## Pitfalls (carry-forward, not subtasks)

1. **Order matters: schema → migration → code.** Run `migrate-pending-invites` *after* the new schema is in place but *before* deploying the new endpoint, or pending-invitee emails will land on a 404.
2. **`PasskeySignupButton.tsx:111` is the GDPR smoking gun.** Removing the hardcoded `acceptedTos: true` is non-negotiable — leaving it would make the new ToS checkbox decorative.
3. **Don't trust prior page state across redirects.** The `/invite/[token]` consent screen → `/auth/signup` hop must re-resolve the token server-side; never pass invite metadata via query string for rendering decisions.
4. **`magic-link-service.ts` body is OFF-LIMITS.** PR #1266 broke when it tried to remove the auto-create branch — magic-link signup is preexisting and zero-trust-approved. Only the orphaned constant comes out in this PR; the function bodies stay untouched.
5. **Email-verification proof comes from the existing signup flow.** This epic does not introduce a new email-verification step; the standard passkey-signup path already proves email control. Resist adding a second email round-trip "for safety" — it would harm conversion without adding security.
6. **No no-op shims.** Per `feedback_no_backwards_compat_for_unreleased.md`, broken-by-cutover code (the broad-sweep helper, the resend route, dead UI bits, the orphaned constant) is deleted *in this PR*, not left as a no-op for "later cleanup."
7. **Eric Elliott style is enforced, not optional.** Pure predicates, SDA destructured object args, asyncPipe composition, discriminated result objects (no exceptions across boundaries), TDD per `.claude/rules/tdd.mdc`. Match the example in `.claude/rules/review-example.md`.

## Verification (epic-level, post all subtasks)

- `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` all green.
- `pnpm db:generate` produces a single new SQL file with one `CREATE TABLE pending_invites` and the partial index — no drift.
- `pnpm --filter @pagespace/db migrate-pending-invites` (against a seeded local DB) deletes the legacy `acceptedAt IS NULL` rows + orphan email-only users, and is idempotent on second run.
- E2E in `pnpm --filter web dev`:
  - **New invitee**: invite a fresh email → DB has `pending_invites` row, **no `users` row** → click email link → consent screen → "Create account & join" → signup with ToS checkbox required → DB has `users` (with `tosAcceptedAt`, `emailVerified` set) + `drive_members` (`acceptedAt` set) + `pending_invites.consumedAt` set → land on `/dashboard/<driveId>?welcome=true`.
  - **Existing user, fast path**: invite a verified existing email → `drive_members` row written directly via `handleUserIdPath`, no email sent, no `pending_invites` row.
  - **Existing user via email link**: consent screen → "Sign in to join" → `/invite/<token>/accept` → if no session, two-click via `/auth/signin?invite=<token>` → land on `/dashboard/<driveId>?invited=1`.
  - **Forwarded invite**: forward link to wrong recipient → email field locked to invitee on signup; cannot complete signup without controlling that email.
  - **Wrong-email accept attempt**: log in as user A, click invite for user B → `EMAIL_MISMATCH` → `/dashboard?inviteError=EMAIL_MISMATCH`; no membership granted; token unconsumed.
  - **Expired invite**: 48h+ → consent screen shows opaque "this invite is no longer valid" card; no auth, no membership.
  - **Replay**: consume, click again → opaque card; no double-membership.
  - **Magic-link signup unchanged**: request magic link from `/auth/magic-link`, verify, dashboard — no `pending_invites` interaction (regression check).
  - **Passkey signin unchanged**: existing passkey login still works, no silent magic-link bypass possible.

## Out of scope (document in PR body)

- `next=` plumbing on `/auth/signin?invite=` (the two-click fallback is acceptable for this PR).
- OAuth invite acceptance (`?invite=` plumbing through Google/Apple flows).
- Magic-link signup ToS gate (separate concern; magic-link service body is off-limits this PR).
- Members-UI pending-invites list (existing `pendingMembers` section in `DriveMembers.tsx` will render empty post-cutover; refactor later).
- `magic-link-service.ts` body — only the orphaned `INVITATION_LINK_EXPIRY_MINUTES` constant is removed.
