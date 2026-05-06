# Drive Invites GDPR + Zero-Trust Epic

**Status**: 📋 PLANNED
**Goal**: Stop creating `users` rows at invite-send time; route invitees through standard signup/login with affirmative ToS acceptance and zero-auth-power tokens.

## Overview

Drive invites currently auto-create a `users` row when the inviter sends — before the invitee has clicked anything, seen a privacy policy, or consented (`apps/web/src/app/api/drives/[driveId]/members/invite/route.ts:407` → `packages/lib/src/auth/magic-link-service.ts:124-131`) — and the resulting 7-day magic-link is the *sole* credential needed to take over that pre-baked account, silently bypassing passkeys for users who already have one (`apps/web/src/app/api/auth/magic-link/verify/route.ts:79-103`). That violates GDPR Art. 6 lawful basis and Art. 13 transparency (a persistent identity is processed before the data subject does anything that constitutes consent), violates zero-trust (URL possession = identity = full session, no passkey check), and breaks the UX expectation set by Slack/Notion/Linear/Google Drive (none auto-create accounts; all route invites through standard signup/login with a consent gate). The fix moves pending state into a dedicated `pendingInvites` table, makes the invite token a page-load credential with no auth power, sends invitees through `/invite/[token]` (consent screen) → `/auth/signup?invite=<token>` (real ToS checkbox, locked email) or `/auth/login?invite=<token>` (passkey, no bypass), and consumes the invite via Eric-Elliott-style `asyncPipe(validate → consume → grant)` only after the standard signup/login flow has minted a session. Hard cutover per project convention (no backwards-compat for unreleased features). One side-effect of removing the `acceptedAt = null` semantic from `driveMembers`: every row in `driveMembers` after this epic represents real, accepted membership, which closes the entire `Drive Invites by Email — followups` list in `plan.md` (the seven authz callsites that forgot to gate on `acceptedAt` become correct by construction).

---

## pendingInvites schema

Add a new `pendingInvites` table in `packages/db/src/schema/` with `id`, `tokenHash`, `email`, `driveId`, `role`, `invitedBy`, `expiresAt`, `consumedAt`, `createdAt`. Generate the migration via `pnpm db:generate`. Includes a partial unique index on `(driveId, lower(email))` where `consumedAt IS NULL` to prevent duplicate active invites.

**Requirements**:
- Given a drive is hard-deleted, should cascade-delete its `pendingInvites` rows so abandoned tokens cannot be replayed against re-created drives sharing an id.
- Given two invites are sent for the same `(driveId, email)` pair while the first is unconsumed, should reject the second at the DB level (partial unique index), not just in application code.
- Given the migration is generated, should contain only one `CREATE TABLE` and the partial index — no incidental drift on `driveMembers`.

---

## Pure invite predicates

Create `packages/lib/src/services/invite-predicates.ts` (or similar) exporting `isInviteExpired({ expiresAt, now })`, `isInviteConsumed({ consumedAt })`, `isEmailMatchingInvite({ inviteEmail, userEmail })`. Tests first, colocated.

**Requirements**:
- Given `userEmail` differs from `inviteEmail` only by case or surrounding whitespace, should return `true` from `isEmailMatchingInvite` (normalize both to trimmed lowercase before comparing) — same normalization the invite endpoint already applies.
- Given the predicates, should be pure functions with destructured object args (SDA), no DB or `Date.now()` calls inside — `now` is injected.
- Given each predicate has a corresponding `assert({ given, should, actual, expected })` test, should cover the false branch as well as the true branch (e.g., expired-by-one-ms, exact-match, off-by-one).

---

## Invite token primitive

Create `createInviteToken()` in `packages/lib/src/auth/invite-token.ts` returning `{ token, tokenHash, expiresAt }`. Uses 32 bytes of `crypto.randomBytes`, base64url-encoded; hash via the same SHA3-256 helper sessions use (find it in `packages/lib/src/auth/`). Default expiry 48h.

**Requirements**:
- Given the same SHA3-256 hash helper exists for sessions, should reuse it rather than introducing a second hashing primitive.
- Given the function returns `tokenHash`, should never persist or log the raw `token` itself — only the hash lives at rest.
- Given a verification helper `verifyInviteToken({ token, tokenHash })`, should compare hashes via timing-safe comparison (per `.claude/rules/timing-safe-compare` if it exists, otherwise `crypto.timingSafeEqual` on equal-length buffers).

---

## pendingInvites repository

Add CRUD methods to `apps/web/src/lib/repositories/drive-invite-repository.ts`: `createPendingInvite`, `findPendingInviteByTokenHash`, `markInviteConsumed`, `findActivePendingInviteByDriveAndEmail`. Remove `findPendingMembersForUser` (no longer used after the post-login sweep is replaced).

**Requirements**:
- Given an attempt to consume an already-consumed invite, should return `false` (no rows updated) via `WHERE consumedAt IS NULL` in the UPDATE — atomic single-use, no read-then-write race.
- Given `findPendingInviteByTokenHash` returns the row, should also return the joined `drive.name` and `inviter.name` so the consent page can render in a single query (no N+1).
- Given `findPendingMembersForUser`, should be deleted in this same task — leaving it would let the broad post-login sweep remain a hidden code path.

---

## Rewrite invite endpoint

In `apps/web/src/app/api/drives/[driveId]/members/invite/route.ts`, replace the `createMagicLinkToken` + `driveMembers` insert with `createInviteToken` + `pendingInvites` insert when the email has no verified user. The existing-verified-user fast path (`route.ts:367` `handleUserIdPath`) is unchanged. Update the email template (wherever `sendPendingDriveInvitationEmail` body is generated) to point at `${appUrl}/invite/${token}` and reword the body.

**Requirements**:
- Given the email send fails after `pendingInvites` row was created, should roll back the `pendingInvites` row (mirror the existing rollback at `route.ts:449-475`).
- Given an unverified existing `users` row exists for the email (orphan from a prior revoked invite), should treat as a new-invite path (route through `pendingInvites`), not the verified-user fast path — the orphan user row is left as-is for the data-migration task to clean up.
- Given the `INVITATION_LINK_EXPIRY_MINUTES = 60*24*7` constant, should be removed or reduced to 48h — invite tokens no longer carry auth power but should still expire promptly.
- Given existing `DRIVE_INVITE` rate limiter wrapping the route, should remain in place unchanged.

---

## /invite/[token] consent page

New `apps/web/src/app/invite/[token]/page.tsx` server component. Resolves the token via `resolveInviteContext({ token })`. Renders inviter, drive name, role, the invited email (read-only), a ToS+Privacy summary with a required checkbox, and a single CTA — "Create account & join" → `/auth/signup?invite=<token>` for new users, "Sign in to join" → `/auth/login?invite=<token>` for existing users (`isExistingUser` is `true` when the email maps to a user with `tosAcceptedAt IS NOT NULL`).

**Requirements**:
- Given the token is invalid, expired, or consumed, should render a public "this invite is no longer valid" page — never redirect to signup or login (which would leak that an invite ever existed for that token).
- Given the page is server-rendered and `params` is a `Promise` per Next.js 15, should `await context.params` — destructuring directly is a silent runtime bug.
- Given the page resolves the token to determine `isExistingUser`, should not disclose any other PII about the existing user (no name, no last-login) — only that this email already has an account.
- Given a CSRF concern, should embed the token in a POST-form submit to `/auth/signup?invite=<token>` rather than a GET link if the signup flow expects POST — match the pattern the existing signup page uses.

---

## ToS checkbox in PasskeySignupButton

Replace the hardcoded `acceptedTos: true` at `apps/web/src/components/auth/PasskeySignupButton.tsx:111` with a real form field. Add a checkbox above the submit button labeled "I agree to the Terms of Service and Privacy Policy" with links. Block submission if unchecked.

**Requirements**:
- Given a user submits the form without checking the ToS box, should block submission client-side AND server-side — server validates `acceptedTos === true` in the request body, returns 400 with a structured error if not.
- Given existing tests assert signup succeeds, should be updated to send `acceptedTos: true` explicitly — silent passing through omission would mask the new server validation.
- Given the existing footer text "By signing up, you agree to our Terms and Privacy Policy" at `apps/web/src/app/auth/signup/page.tsx:160-174`, should be removed (the checkbox replaces it, not duplicates it).

---

## Signup invite integration

In `apps/web/src/app/auth/signup/page.tsx`, accept `?invite=<token>` query param. Resolve the token server-side. Pre-fill the email field from the invite and render it as `disabled`. Render a top-of-page banner: "You're joining **[drive]**, invited by **[inviter]**".

**Requirements**:
- Given an invite token resolves to an email, should render the email field as `disabled` (not just `readOnly`) so it cannot be programmatically edited via DevTools form-field overrides — and re-validate server-side on submit.
- Given the invite token is invalid or expired by the time the user submits, should let signup succeed for the entered email but display a non-blocking toast on the dashboard ("Invite expired — ask the inviter to send a new one"). Signup and invite-acceptance are independent.
- Given a logged-in user lands on `/auth/signup?invite=<token>` with a session that does not match the invite email, should sign them out before rendering — preventing the existing session from accidentally claiming an invite for a different email.

---

## acceptInviteForNewUser pipe

Compose `acceptInviteForNewUser` in `packages/lib/src/services/invite-acceptance.ts` as `asyncPipe(validateInviteToken, validateEmailMatchesInvite, consumeInviteToken, createDriveMembership)`. Call it in the passkey-signup success path right after the user row is created (`packages/lib/src/auth/passkey-service.ts` near line 902-903 where `tosAcceptedAt` and `emailVerified` are set).

**Requirements**:
- Given any step in the pipe returns `{ ok: false }`, should not throw — boundaries convert the result into a structured response so the caller can render a toast without try/catch.
- Given the pipe runs after user creation but before session mint, should treat invite failure as non-fatal (signup still completes, session still issued, dashboard renders an "invite couldn't be accepted" toast).
- Given the pipe writes both `pendingInvites.consumedAt` and `driveMembers`, should run those two writes in a single transaction so a crash mid-pipe cannot consume the token without granting the membership.

---

## Login invite integration

In `apps/web/src/app/auth/login/...`, accept `?invite=<token>` param and render the same "You're joining [drive]" banner. No auth path change.

**Requirements**:
- Given a user already logged in with a different email lands on `/auth/login?invite=<token>`, should display the banner with a "switch account" prompt rather than silently accepting the invite for the wrong account.
- Given the login page already supports passkey + magic-link, should not introduce a new auth method to support invites — the param is purely contextual UI.

---

## acceptInviteForExistingUser pipe + replace post-login sweep

Compose `acceptInviteForExistingUser` similar to `acceptInviteForNewUser` but for already-authenticated users. Wire it into the post-login flow in place of `acceptUserPendingInvitations(userId)` at `apps/web/src/lib/auth/post-login-pending-acceptance.ts:33`. Delete the broad userId-keyed sweep entirely.

**Requirements**:
- Given an authenticated user logs in *without* an `?invite=<token>` (normal login), should NOT run any pending-invite query — pending state lives in `pendingInvites` keyed on email/token, no broad sweep is correct or needed.
- Given the logged-in user's email does not match `pendingInvites.email`, should reject acceptance and surface "this invite is for a different account" — matches the zero-trust requirement that token possession alone never grants membership.
- Given `acceptUserPendingInvitations` is referenced from any other call site (e.g., OAuth callback), should be replaced with the targeted `acceptInviteForExistingUser` form there too — leaving the broad sweep behind anywhere preserves the old vulnerability surface.

---

## Remove magic-link auto-create

Delete the user auto-creation branch at `packages/lib/src/auth/magic-link-service.ts:119-157`. Magic-link verification of an unknown email returns `NO_ACCOUNT_FOUND`. Adjust `apps/web/src/app/api/auth/magic-link/verify/route.ts` to render the error gracefully.

**Requirements**:
- Given a magic-link request for an email with no `users` row, should return `NO_ACCOUNT_FOUND` and not create any DB rows — the only previously-known caller (drive invites) no longer issues magic-links, so this branch is dead code with security implications.
- Given existing tests cover the auto-create branch, should be updated to assert the new error path instead — silently dropping the test would mask the behavior change.
- Given the `verificationTokens.metadata` field carries desktop platform data for legitimate magic-link login, should remain unchanged — only the user-creation side effect is removed.

---

## Data migration

One-shot script (or migration step): for every existing `driveMembers` row with `acceptedAt IS NULL`, generate a fresh `pendingInvites` row (new token, fresh 48h expiry — the user must re-receive the invite to act), then delete the original `driveMembers` row. Then delete every `users` row whose only state is "created by old invite path with no auth credentials" (no passkeys, no `tosAcceptedAt`, no `emailVerified`, no other linked content).

**Requirements**:
- Given a `users` row created by the old invite path has any linked content beyond a pending `driveMembers` row (page authorship, comments, sessions, anything), should NOT be deleted — only true orphans go.
- Given the new `pendingInvites` row replaces the old `driveMembers` pending row, should send a *new* invite email to the original recipient so they can act on it; do not silently re-issue without notifying.
- Given the migration runs, should record a count of rows ported and orphans deleted, written to migration logs for audit.
- Given this is an unreleased-feature cutover (per project rule), should not preserve the old `acceptedAt IS NULL` semantic anywhere in code or queries.

---

## Pitfalls (carry-forward, not subtasks)

1. **Order matters: schema → migration → code.** Run the data migration *after* the new schema is in place but *before* deploying the new endpoint, or pending-invitee emails will land on a 404.
2. **`PasskeySignupButton.tsx:111` is the GDPR smoking gun.** Removing the hardcoded `acceptedTos: true` is non-negotiable — leaving it would make the new ToS checkbox decorative.
3. **Don't trust prior page state across redirects.** The `/invite/[token]` consent screen → `/auth/signup` hop must re-resolve the token server-side; never pass invite metadata via query string for rendering decisions.
4. **`plan.md` followups become obsolete.** The `Drive Invites by Email — followups` section listing seven authz callsites that need an `acceptedAt` gate is naturally fixed by removing the `acceptedAt IS NULL` semantic — remove that section from `plan.md` as part of this epic, don't leave it dangling.
5. **Email-verification proof comes from the existing signup flow.** This epic does not introduce a new email-verification step; the standard passkey-signup path already proves email control. Resist adding a second email round-trip "for safety" — it would harm conversion without adding security.
6. **Eric Elliott style is enforced, not optional.** Pure predicates, SDA object args, asyncPipe composition, result objects (no exceptions across boundaries), TDD with assert. Match the example in `.claude/rules/review-example.md`.

## Verification (epic-level, post all subtasks)

- `pnpm db:generate`, `pnpm db:migrate`, `pnpm test`, `pnpm typecheck`, `pnpm lint` all green.
- E2E in `pnpm --filter web dev`:
  - **New invitee**: invite a fresh email → DB has `pendingInvites` row, **no `users` row** → click email link → consent screen → "Create account & join" → signup with ToS checkbox required → DB has `users` (with `tosAcceptedAt`, `emailVerified` set) + `driveMembers` (`acceptedAt` set) + `pendingInvites.consumedAt` set → land in drive.
  - **Existing user, fast path**: invite a verified existing email → `driveMembers` row written directly, no email sent, no `pendingInvites` row.
  - **Existing user via email link** (alternate path if/when surfaced): consent screen → `/auth/login?invite=<token>` → passkey → drive accepted, no magic-link bypass.
  - **Forwarded invite**: forward link to wrong recipient → email field locked to invitee → cannot complete signup without controlling that email.
  - **Wrong-email signup attempt**: try to sign up with a different email than the token → invite remains unconsumed, signup may succeed for the new email but no drive membership granted.
  - **Magic-link to non-existent email**: returns `NO_ACCOUNT_FOUND`, no `users` row created.
  - **Expired invite**: invite past 48h → consent screen shows "this invite is no longer valid"; no auth, no membership.
  - **Replay**: consume an invite, click again → "invite already used"; no double-membership.
- Unit tests for every pure predicate and pipe step using `assert({ given, should, actual, expected })`.

## Out of scope

In-app notification banner for already-logged-in invitees (follow-up epic — surface invite via in-app toast instead of email round-trip); ToS versioning / re-acceptance on policy changes; production data cleanup beyond the one-shot migration in this epic; DPIA / privacy policy text updates (coordinate with whoever owns legal copy).
