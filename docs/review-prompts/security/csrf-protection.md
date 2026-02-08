# Review Vector: CSRF Protection

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- security.mdc

## Scope
**Files**: `apps/web/src/app/api/auth/csrf/**`, `apps/web/src/app/api/auth/login-csrf/**`
**Level**: domain

## Context
PageSpace uses dedicated CSRF token endpoints to protect state-changing operations, with separate flows for general CSRF and login-specific CSRF. Review the token generation entropy, binding mechanism (is it tied to the session or a separate nonce?), and validation logic on the server side. Assess whether all mutating API routes consistently enforce CSRF checks and whether the token delivery mechanism itself is resistant to exfiltration.
