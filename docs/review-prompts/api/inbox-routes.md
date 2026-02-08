# Review Vector: Inbox Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/inbox/**/route.ts`
**Level**: route

## Context
The inbox route provides a unified feed aggregating notifications, direct messages, task assignments, and mentions into a single prioritized stream. It pulls from multiple data sources and must apply consistent permission filtering across all item types so that users only see items they are authorized to access. Performance is a concern since this endpoint joins across several tables for each request, so pagination and efficient query construction are critical review targets.
