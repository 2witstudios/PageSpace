# Review Vector: Auth System

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- auth.mdc
- security.mdc

## Scope
**Files**: `packages/lib/src/auth/**`, `apps/web/src/middleware.ts`, `apps/web/src/lib/auth/**`
**Level**: service

## Context
The authentication system uses custom JWT-based tokens with jose for signing and verification, bcryptjs for password hashing, and middleware for route protection. Token refresh flows, session management, and CSRF protection are critical security surfaces that must be reviewed for correctness and resistance to common attack vectors. Any changes here directly impact every authenticated request in the application.
