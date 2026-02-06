# Review Vector: Cron Jobs

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc

## Scope
**Files**: `apps/web/src/app/api/cron/**/route.ts`
**Level**: service

## Context
Cron job routes are triggered on a schedule to perform background maintenance tasks such as cleanup, synchronization, and usage aggregation. These endpoints must be protected from unauthorized external invocation and designed to be idempotent since duplicate triggers are possible. Review should verify timeout handling, error recovery, and that long-running operations do not block or exceed serverless execution limits.
