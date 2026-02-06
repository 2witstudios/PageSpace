# Review Vector: Signup and Verify Email

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/auth/signup/route.ts`, `apps/web/src/app/api/auth/verify-email/route.ts`, `apps/web/src/app/api/auth/resend-verification/route.ts`, `packages/lib/src/auth/verification-utils.ts`, `packages/lib/src/services/email-service.ts`, `packages/lib/src/email-templates/VerificationEmail.tsx`, `packages/db/src/schema/auth.ts`, `packages/db/src/schema/core.ts`, `apps/web/src/lib/auth/auth.ts`, `apps/web/src/lib/auth/cookie-config.ts`
**Level**: domain

## Context
The signup journey begins at the auth signup route which validates input, hashes the password with bcryptjs, creates a user record in PostgreSQL via Drizzle, and dispatches a verification email through the email service. The user clicks the verification link which hits the verify-email route, validates the token, marks the account as active in the database, and redirects to the authenticated app. This flow crosses the API layer, email service, database writes, token generation via jose, and cookie/session establishment.
