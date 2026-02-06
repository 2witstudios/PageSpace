# Review Vector: Page Permissions

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- permissions.mdc
- api-routes.mdc

## Scope
**Files**: `apps/web/src/app/api/pages/[pageId]/permissions/**`, `apps/web/src/app/api/permissions/**`, `packages/lib/src/permissions/**`
**Level**: domain

## Context
Page-level access control layers on top of drive membership to provide granular read, write, and admin permissions per page. The centralized permission logic in @pagespace/lib/permissions must be the single source of truth, with API routes and frontend components both consuming it consistently. Permission checks must account for inheritance from parent pages, drive-level roles, and explicit per-page overrides without creating authorization gaps.
