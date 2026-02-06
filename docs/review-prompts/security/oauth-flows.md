# Review Vector: OAuth Flows

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- security.mdc

## Scope
**Files**: `apps/web/src/app/api/auth/**`, `apps/web/src/lib/ios-apple-auth.ts`, `apps/web/src/lib/ios-google-auth.ts`
**Level**: service

## Context
PageSpace integrates with Apple and Google as OAuth providers, with dedicated iOS-specific auth flows alongside web-based callbacks. Review the state parameter generation and validation to prevent CSRF in the OAuth dance, the code-to-token exchange security, and how provider identity tokens are verified before linking to local accounts. Examine whether the iOS-specific flows properly validate the audience claim and whether account linking logic prevents account takeover through email collision.
