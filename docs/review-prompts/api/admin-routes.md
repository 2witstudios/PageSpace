# Review Vector: Admin Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/admin/**/route.ts`
**Level**: route

## Context
Admin routes provide platform administration: user listing and management, gift subscription assignment, subscription overrides, contact message management, global AI prompt configuration, database schema inspection, and audit log operations including export and integrity verification. Every endpoint must enforce admin-role authorization as the first check. Audit log integrity verification uses cryptographic chaining to detect tampering, so the integrity endpoint must validate the full hash chain. Gift subscription and subscription override endpoints modify billing state outside of Stripe, requiring careful synchronization.
