# Review Vector: Task Management

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc
- permissions.mdc

## Scope
**Files**: `apps/web/src/components/tasks/**`, `apps/web/src/app/api/tasks/**`, `apps/web/src/app/api/pages/[pageId]/tasks/**`
**Level**: domain

## Context
Tasks support custom statuses and multiple assignees, with both frontend components and API route handlers working in concert. The API routes must follow Next.js 15 async params patterns and enforce page-level permissions before allowing task mutations. Task state changes generate activity log entries and may trigger notifications to assignees across the drive membership.
