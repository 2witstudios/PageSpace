# Review Vector: File Upload Security

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- security.mdc

## Scope
**Files**: `apps/processor/src/**`, `apps/web/src/app/api/upload/**`, `apps/web/src/app/api/files/**`
**Level**: service

## Context
File uploads flow from the web API through to the processor service which handles image optimization and content extraction, with content-addressed storage on the local filesystem and metadata in PostgreSQL. Review the file validation pipeline: MIME type verification (header-based vs. magic bytes), size limit enforcement at both the API and processor layers, and path construction logic for stored files. Examine whether the processor is resistant to zip bombs, polyglot files, and path traversal via crafted filenames, and whether served files have appropriate Content-Disposition and Content-Type headers.
