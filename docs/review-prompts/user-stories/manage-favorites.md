# Review Vector: Manage Favorites

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/user/favorites/route.ts`, `apps/web/src/app/api/user/favorites/[id]/route.ts`, `apps/web/src/app/api/user/favorites/reorder/route.ts`, `apps/web/src/hooks/useFavorites.ts`, `apps/web/src/stores/useUIStore.ts`, `apps/web/src/hooks/usePageNavigation.ts`
**Level**: domain

## Context
The favorites journey starts when a user stars a page, which POSTs to the favorites API to create a favorite record linked to the user and page. The useFavorites hook manages the SWR cache, ensuring the sidebar favorites section updates immediately with optimistic mutation. Reordering favorites triggers the reorder endpoint to persist the new sort order. Removing a favorite DELETEs via the favorites ID route. This flow crosses the favorites API routes, SWR data fetching with cache mutation, the sidebar UI rendering favorites from the hook, and the navigation hook that handles clicking a favorite to open the page.
