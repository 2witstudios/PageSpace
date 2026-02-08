# Review Vector: Rate Limiting

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- security.mdc

## Scope
**Files**: `packages/lib/src/security/**`, `apps/web/src/middleware.ts`
**Level**: service

## Context
Rate limiting is implemented in the shared security package and enforced through middleware to protect against brute force attacks, credential stuffing, and API abuse. Review the rate limit algorithm, storage backend, and key derivation (IP-based, user-based, or composite). Examine whether limits are applied consistently before authentication logic runs, whether the implementation is resistant to bypass via header manipulation, and how rate limit state behaves across service restarts.
