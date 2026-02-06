# Review Vector: Storage Management

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc

## Scope
**Files**: `apps/web/src/app/api/storage/**`
**Level**: domain

## Context
Storage management tracks per-drive and per-user file storage quotas, providing usage breakdowns and enforcement of upload limits. The quota calculation must accurately account for content-addressed storage deduplication so shared files are not double-counted against user limits. API endpoints must atomically check and update quota usage during uploads to prevent race conditions that could allow users to exceed their allocated storage.
