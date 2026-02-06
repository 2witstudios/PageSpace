# Review Vector: Account Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/account/**/route.ts`
**Level**: route

## Context
Account routes manage user profile updates, avatar upload, password changes, device registration and revocation, drive membership status, drive invitation handling, and email verification status checks. These endpoints modify sensitive user data and must enforce strict ownership validation so that users can only modify their own accounts. Password change flows require proper bcrypt hashing and old-password verification.
