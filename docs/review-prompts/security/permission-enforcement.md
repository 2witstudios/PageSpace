# Review Vector: Permission Enforcement

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- security.mdc
- permissions.mdc

## Scope
**Files**: `packages/lib/src/permissions/**`, `apps/web/src/app/api/**/route.ts`
**Level**: service

## Context
PageSpace uses centralized RBAC through getUserAccessLevel and canUserEditPage functions from the shared permissions package, with drive membership and page-level permissions forming a hierarchical access model. Review whether every API route that accesses or mutates resources actually calls the permission check functions before proceeding. Examine the permission logic itself for privilege escalation paths, especially around role transitions, inherited permissions, and edge cases where a user might belong to multiple drives with conflicting access levels.
