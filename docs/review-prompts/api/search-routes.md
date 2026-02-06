# Review Vector: Search & Mentions Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/search/**/route.ts`, `apps/web/src/app/api/mentions/**/route.ts`, `apps/web/src/app/api/users/**/route.ts`
**Level**: route

## Context
Search routes provide single-drive and multi-drive content search across pages the user has access to. Mention search powers the @-mention autocomplete in editors and channels, returning matching users scoped to the current drive's membership. User search and find endpoints support looking up users by name or email for connections and invitations. All search endpoints must enforce drive membership and page-level permissions to prevent information leakage through search results. Query inputs require sanitization to prevent regex injection in server-side pattern matching.
