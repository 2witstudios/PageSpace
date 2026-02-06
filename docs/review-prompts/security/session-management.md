# Review Vector: Session Management

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- security.mdc

## Scope
**Files**: `packages/lib/src/auth/**`, `apps/web/src/middleware.ts`
**Level**: service

## Context
Sessions are managed through JWT tokens with refresh token rotation and per-device session tracking. The middleware intercepts every request to validate the session before routing proceeds. Review the full JWT lifecycle including issuance, refresh, expiration enforcement, and revocation semantics. Examine whether device sessions are properly isolated and whether token replay or fixation attacks are mitigated across the refresh window.
