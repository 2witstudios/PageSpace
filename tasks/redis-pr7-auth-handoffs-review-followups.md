# Task: Auth Handoff Tokens — Post-Review Follow-ups

Scope: review findings on `pu/redis-pr7-auth-handoffs` (PR #1043). One ship-blocker + one test-only miss bundled before merge.

Status: **done** (fix commit to land on the PR branch; changelog updated in same commit).

## Requirements

### R1 — `markPasskeyRegisterOptionsIssued` must succeed on first call ✅

- **Given** a handoff token minted via `createPasskeyRegisterHandoff({ userId })` (which inserts a row with `kind='passkey-register-handoff'` keyed by `hashToken(token)`),
  **should** allow the *first* call to `markPasskeyRegisterOptionsIssued(token)` to insert a `kind='passkey-options-marker'` row with the same `tokenHash` and return `true`; a *second* call with the same token must return `false` (replay detected).

  The existing schema makes `token_hash` the sole PRIMARY KEY, so the mint row and the marker row collide on the PK and `onConflictDoNothing` suppresses the marker insert on every legitimate first call. Desktop passkey registration is fully broken as a result.

  Fix must:
  - Allow both row kinds to coexist for the same `tokenHash`.
  - Keep the single-table / JSONB-payload design intact.
  - Preserve the atomic one-options-per-mint replay guarantee (no two successful marks for the same token).

### R2 — PKCE consume DB-failure test must actually exercise the failure path ✅

- **Given** the integration test "consumePKCEVerifier should return null rather than throw when the delete fails" (`packages/lib/src/auth/__tests__/pkce.integration.test.ts`),
  **should** mock `db.execute` (what `consumePKCEVerifier` actually calls), not `db.delete`. With the current spy, the mock never fires; the test passes by accident because the state was never minted and the real query returns an empty result set. The graceful-degradation guarantee is untested on this path.

## Out of scope

- Changelog entry for PR 7 (will land with the fix commit).
- Any broader schema redesign of `auth_handoff_tokens`.
