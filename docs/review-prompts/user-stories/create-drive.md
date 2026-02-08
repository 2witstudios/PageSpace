# Review Vector: Create Drive

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/drives/route.ts`, `apps/web/src/app/api/drives/[driveId]/route.ts`, `apps/web/src/app/api/drives/[driveId]/members/route.ts`, `apps/web/src/app/api/pages/route.ts`, `packages/db/src/schema/core.ts`, `packages/db/src/schema/members.ts`, `packages/lib/src/permissions/permissions.ts`, `apps/web/src/hooks/useDrive.ts`, `apps/web/src/hooks/usePageTree.ts`, `apps/web/src/stores/useUIStore.ts`
**Level**: domain

## Context
Creating a drive begins with a POST to the drives API which inserts the drive record, assigns the creator as owner in the members table, and creates a default root page. The sidebar re-fetches via SWR to display the new drive, and the page tree hook initializes the tree structure. This journey crosses the API route layer with Next.js 15 async patterns, database transactions across drives/members/pages tables, permission initialization, and frontend state updates in Zustand stores and SWR caches.
