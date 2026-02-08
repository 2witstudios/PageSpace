# Review Vector: Cookie Security

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- security.mdc

## Scope
**Files**: `packages/lib/src/auth/**`, `apps/web/src/app/api/auth/**`
**Level**: domain

## Context
Authentication tokens and CSRF tokens are delivered and persisted through cookies, making cookie configuration a critical security surface. Review every location where cookies are set for correct attribute configuration: httpOnly to prevent JavaScript access, Secure to enforce HTTPS transport, SameSite to limit cross-origin attachment, and appropriate Path/Domain scoping. Examine cookie expiration alignment with token expiration and whether logout flows properly clear all authentication-related cookies including any secondary or legacy cookie names.
