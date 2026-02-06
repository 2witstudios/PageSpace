# Review Vector: Breadcrumbs

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/hooks/useBreadcrumbs.ts`, `apps/web/src/components/layout/**`
**Level**: component

## Context
The breadcrumb system resolves the full ancestor path from the current page up through the page tree to the drive root, rendering clickable segments in the header. The useBreadcrumbs hook must walk the page hierarchy efficiently and update when pages are moved, renamed, or deleted by any user in real time. Breadcrumbs also need to handle edge cases like orphaned pages, permission boundaries where a user cannot see an ancestor, and pages nested many levels deep.
