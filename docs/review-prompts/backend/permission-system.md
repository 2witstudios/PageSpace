# Review Vector: Permission System

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- permissions.mdc
- security.mdc

## Scope
**Files**: `packages/lib/src/permissions/**`
**Level**: service

## Context
The centralized permission system implements RBAC across drives, pages, and workspace resources using functions like getUserAccessLevel and canUserEditPage. Permission checks must be consistent, composable, and never bypassed by direct database queries or API shortcuts. Changes to permission logic have cascading effects across every access-controlled surface in the application.
