# Review Vector: Calendar

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc

## Scope
**Files**: `apps/web/src/components/calendar/**`, `apps/web/src/app/api/calendar/**`
**Level**: domain

## Context
The calendar feature provides event creation, editing, and visualization across day, week, and month views. API routes handle date range queries and must correctly handle timezone conversions and recurring event patterns. Frontend components coordinate with SWR for data fetching and must respect the editing store protection pattern during event modifications.
