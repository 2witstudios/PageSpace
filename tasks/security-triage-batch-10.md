# Security Alert Triage — Batch 10: Insufficient Password Hash in OAuth State

## Summary

Both alerts are **S3 — False Positive**. CodeQL's `js/insufficient-password-hash` rule misidentifies HMAC-SHA256 message authentication as password hashing. No code changes required.

## Alert #96 — js/insufficient-password-hash
- **File**: `packages/lib/src/integrations/oauth/oauth-state.ts:65`
- **Rating**: S3 — False Positive
- **Rationale**: This is HMAC-SHA256 message authentication (`crypto.createHmac('sha256', signingKey)`) for OAuth CSRF state tokens, not password hashing. The signing key is a server-controlled secret (e.g., `process.env.OAUTH_STATE_SECRET`), not a user password. HMAC-SHA256 is the industry standard for message authentication codes. The implementation also uses `crypto.timingSafeEqual` for signature comparison and enforces 10-minute token expiry. Actual password hashing in PageSpace uses bcryptjs (confirmed in `apps/web/src/app/api/auth/login/route.ts`, `signup/route.ts`, etc.).
- **Action**: Dismiss — "False positive: This is HMAC-SHA256 message authentication (crypto.createHmac) for OAuth CSRF state tokens, not password hashing. The signing key is a server-controlled secret, not a user password. HMAC-SHA256 is the standard algorithm for state token signing. Actual password hashing uses bcryptjs."

## Alert #97 — js/insufficient-password-hash
- **File**: `packages/lib/src/integrations/oauth/oauth-state.test.ts:80`
- **Rating**: S3 — False Positive
- **Rationale**: Test file replicating the same HMAC-SHA256 signing to validate the expiration code path. Same false positive as #96 — HMAC signing, not password hashing. Additionally, this is a test file with no production exposure.
- **Action**: Dismiss — "False positive: Test file exercising HMAC-SHA256 state signing (same as #96). No production exposure."
