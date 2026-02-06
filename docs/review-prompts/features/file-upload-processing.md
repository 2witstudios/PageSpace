# Review Vector: File Upload and Processing

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc
- processor.mdc

## Scope
**Files**: `apps/web/src/app/api/upload/**`, `apps/web/src/app/api/files/**`, `apps/processor/src/**`
**Level**: domain

## Context
File uploads flow from the web app API through to the processor service for image optimization, thumbnail generation, and content extraction into the content-addressed storage system. The upload API must validate file types and sizes, enforce storage quotas, and hand off to the processor service reliably. The processor service runs as a separate Docker container and must handle failures gracefully, including retry logic and dead-letter handling for files that cannot be processed.
