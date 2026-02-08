# Review Vector: Login with OAuth

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/auth/google/signin/route.ts`, `apps/web/src/app/api/auth/google/callback/route.ts`, `apps/web/src/app/api/auth/google/one-tap/route.ts`, `apps/web/src/app/api/auth/apple/signin/route.ts`, `apps/web/src/app/api/auth/apple/callback/route.ts`, `packages/lib/src/auth/oauth-utils.ts`, `packages/lib/src/auth/oauth-types.ts`, `packages/lib/src/auth/token-utils.ts`, `apps/web/src/lib/auth/cookie-config.ts`, `apps/web/src/lib/auth/origin-validation.ts`, `packages/db/src/schema/auth.ts`
**Level**: domain

## Context
The OAuth journey starts when a user clicks a provider button, which redirects to the signin route that constructs the OAuth authorization URL with state and PKCE parameters. After provider consent, the callback route exchanges the authorization code for tokens, upserts the user in the database, generates JWT access/refresh tokens, sets secure cookies, and redirects to the app. This flow spans OAuth protocol handling, CSRF state validation, origin security checks, database user creation, and session establishment across multiple route handlers.
