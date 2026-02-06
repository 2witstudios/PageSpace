# Review Vector: Security Test Coverage

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- tdd.mdc

## Scope
**Files**: `apps/web/src/app/api/auth/__tests__/**`, `**/*security*.test.ts`
**Level**: testing

## Context
Security-specific tests must cover authentication flows, token validation, CSRF protection, rate limiting, and authorization boundary enforcement. Every permission-gated API route should have tests verifying that unauthenticated requests, expired tokens, and insufficient permissions are correctly rejected. Input sanitization and injection prevention for user-supplied content in pages, comments, and search queries require dedicated test cases.
