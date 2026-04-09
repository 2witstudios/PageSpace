# Security Alert Triage — Batch 10: Insufficient Password Hash in OAuth State

## Summary

CodeQL's `js/insufficient-password-hash` rule misidentifies HMAC-SHA256 message authentication as password hashing — the specific alert is a **false positive (S3)**. However, zero-trust review of the flagged code revealed a timing side-channel in the signature comparison: the length check short-circuited before comparison, leaking length information. Upgraded to **S2 — Should Fix** and consolidated all callers to use `secureCompare` from `@pagespace/lib` (SHA-256 double-hash + `timingSafeEqual`).

## Alert #96 — js/insufficient-password-hash
- **File**: `packages/lib/src/integrations/oauth/oauth-state.ts:65`
- **Rating**: S2 — Should Fix (upgraded from S3)
- **Rationale**: The CodeQL alert itself is a false positive — this is HMAC-SHA256 message authentication, not password hashing. However, the `verifySignedState` function had a timing side-channel: length check short-circuited before comparison, leaking length information. Fixed by consolidating to `secureCompare` from `@pagespace/lib`.
- **Action**: Fixed — all callers now use `secureCompare` (SHA-256 hash + `timingSafeEqual`). Also hardened `OAUTH_STATE_SECRET` env validation from `min(1)` to `min(32)`.

## Alert #97 — js/insufficient-password-hash
- **File**: `packages/lib/src/integrations/oauth/oauth-state.test.ts:80`
- **Rating**: S3 — False Positive
- **Rationale**: Test file exercising HMAC-SHA256 state signing. No production exposure. The test's `createHmac` usage is correct for re-signing test data.
- **Action**: Dismiss — "False positive: Test file exercising HMAC-SHA256 state signing. No production exposure."

## Additional hardening (found during zero-trust review)
- **`packages/lib/src/auth/csrf-utils.ts`**: Same timing side-channel pattern — consolidated to `secureCompare` from `@pagespace/lib`.
- **`packages/lib/src/config/env-validation.ts:53`**: `OAUTH_STATE_SECRET` validated as `min(1)` — upgraded to `min(32)` to enforce minimum key entropy.
