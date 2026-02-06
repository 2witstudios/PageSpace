# Review Vector: Google Calendar Integration

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- tdd.mdc

## Scope
**Files**: `packages/lib/src/integrations/**`, `apps/web/src/app/api/integrations/**`, `apps/web/src/app/api/calendar/**`, `apps/web/src/lib/integrations/**`
**Level**: integration

## Context
The Google Calendar integration manages OAuth token lifecycle, event synchronization, and webhook-based change notifications. Token refresh logic must handle expiration gracefully without dropping user sessions or creating duplicate calendar entries. Event sync should be idempotent and conflict-resilient, properly mapping between PageSpace task data and Google Calendar event schemas.
