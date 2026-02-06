# Review Vector: Multi-Tenant Isolation

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- security.mdc
- permissions.mdc

## Scope
**Files**: `packages/lib/src/permissions/**`, `packages/lib/src/repositories/**`, `packages/db/src/schema/**`
**Level**: service

## Context
PageSpace is organized around drives as tenancy boundaries, where each drive contains its own pages, files, and membership roster. Data isolation depends on query scoping through drive membership checks at the repository and permission layers rather than database-level row security. Review whether every data access path consistently scopes queries to the user's authorized drives, and whether any cross-drive operations (search, mentions, shared pages) leak data from drives the requesting user does not belong to. Examine the schema foreign key relationships for implicit cross-tenant references.
