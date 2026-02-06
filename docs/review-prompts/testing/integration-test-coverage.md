# Review Vector: Integration Test Coverage

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- tdd.mdc

## Scope
**Files**: `apps/web/src/app/api/**/__tests__/**`
**Level**: testing

## Context
API route integration tests verify that request handling, database interactions, and response formatting work correctly end-to-end within route handlers. Each API route should have corresponding integration tests that exercise the full request lifecycle including authentication, authorization, input validation, and error responses. Missing integration tests for critical routes like AI endpoints, file operations, and permission-gated resources represent significant risk.
