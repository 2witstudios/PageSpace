# Review Vector: API Authorization

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- security.mdc

## Scope
**Files**: `apps/web/src/middleware.ts`, `apps/web/src/app/api/**/route.ts`
**Level**: service

## Context
The Next.js middleware provides the first layer of route protection, with individual route handlers performing additional authorization checks against user roles and resource ownership. Review the middleware's route matching logic to identify any unprotected routes that should require authentication. Examine whether admin-only endpoints verify the admin role consistently and whether the authorization logic in route handlers is duplicated ad-hoc or properly delegates to shared permission utilities. Assess how unauthenticated and unauthorized requests are handled to avoid information disclosure.
