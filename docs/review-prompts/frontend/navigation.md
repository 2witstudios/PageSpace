# Review Vector: Navigation

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/lib/navigation/**`, `apps/web/src/hooks/useBreadcrumbs.ts`
**Level**: component

## Context
PageSpace implements custom back/forward navigation buttons in the main header, supplementing the browser's native history with application-aware navigation state tracked in lib/navigation/. The navigation system must handle transitions between drives, pages, and settings views while coordinating with the tab system so that tab switches and page navigations produce correct history entries. Breadcrumb resolution depends on the page tree hierarchy and must update correctly when pages are moved or renamed.
