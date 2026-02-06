# Review Vector: Version History

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc

## Scope
**Files**: `apps/web/src/components/version-history/**`, `apps/web/src/app/api/pages/[pageId]/history/**`, `apps/web/src/app/api/pages/[pageId]/versions/**`
**Level**: domain

## Context
Version history enables users to browse previous page states and view diffs between any two versions. The API routes must await async params per Next.js 15 conventions and validate that the requesting user has read access to the page. Diff rendering on the frontend must handle both text-based content and structured document formats while clearly indicating additions, deletions, and modifications.
