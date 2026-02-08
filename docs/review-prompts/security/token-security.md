# Review Vector: Token Security

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- security.mdc

## Scope
**Files**: `packages/lib/src/auth/**`, `apps/web/src/middleware.ts`
**Level**: service

## Context
JWTs are signed using the jose library and delivered to clients via cookies for web sessions and bearer tokens for API/mobile access. Review the signing algorithm selection, key strength, and whether the implementation is vulnerable to algorithm confusion attacks. Examine cookie attributes (httpOnly, Secure, SameSite, Path, Domain) and whether token claims include appropriate audience and issuer restrictions. Assess token storage on the client side and whether sensitive claims are exposed unnecessarily in the payload.
