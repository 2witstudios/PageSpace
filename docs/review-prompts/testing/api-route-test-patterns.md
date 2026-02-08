# Review Vector: API Route Test Patterns

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- tdd.mdc

## Scope
**Files**: `apps/web/src/app/api/**/__tests__/**`
**Level**: testing

## Context
API route tests must follow consistent patterns for request mocking, authentication simulation, and response validation across the codebase. Auth simulation should use the established JWT mocking approach rather than bypassing middleware. Response assertions should validate status codes, JSON structure, and error message formats to ensure API contract stability.
