# Review Vector: Upload Pipeline

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `apps/processor/src/**`
**Level**: service

## Context
The processor service accepts file uploads from the web app, validates them, writes them to content-addressed local storage, and records metadata in PostgreSQL. Review the end-to-end upload flow for correct streaming, size limits, MIME type validation, and transactional consistency between filesystem writes and database inserts. Partial failure cleanup is critical to verify.
