# Review Vector: Search Across Drives

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/search/route.ts`, `apps/web/src/app/api/search/multi-drive/route.ts`, `apps/web/src/app/api/drives/[driveId]/search/regex/route.ts`, `apps/web/src/app/api/drives/[driveId]/search/glob/route.ts`, `apps/web/src/components/search/GlobalSearch.tsx`, `apps/web/src/components/search/InlineSearch.tsx`, `apps/web/src/hooks/usePageNavigation.ts`, `packages/lib/src/permissions/permissions.ts`
**Level**: domain

## Context
The search journey begins when a user opens the global search dialog and types a query. The GlobalSearch component debounces input and calls the search API, which fans out to the multi-drive search route to query across all drives the user has access to. Results are filtered through the permission system to ensure the user can only see pages they are authorized to view. Selecting a result triggers navigation via the usePageNavigation hook. This flow crosses the search UI components, multiple API route handlers, permission-filtered database queries, and client-side navigation state.
