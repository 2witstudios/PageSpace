# Review Vector: Onboarding

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc
- security.mdc

## Scope
**Files**: `apps/web/src/components/auth/**`, `apps/web/src/lib/onboarding/**`
**Level**: domain

## Context
The onboarding flow covers user signup, email verification, and first drive creation as a multi-step guided experience. Authentication during signup must use secure password hashing with bcryptjs and issue JWT tokens correctly upon completion. The flow must handle interrupted sessions gracefully so users can resume onboarding without losing progress, and email verification tokens must have proper expiration and single-use enforcement.
