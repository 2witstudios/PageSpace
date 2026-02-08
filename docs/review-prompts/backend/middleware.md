# Review Vector: Middleware

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- auth.mdc
- security.mdc

## Scope
**Files**: `apps/web/src/middleware.ts`
**Level**: service

## Context
The Next.js middleware runs on every request and handles authentication verification, route protection, CSRF validation, and request preprocessing before handlers execute. It is the single enforcement point for unauthenticated access prevention and must be reviewed with extreme care for bypass vulnerabilities. Performance is critical since middleware latency directly impacts every page load and API call.
