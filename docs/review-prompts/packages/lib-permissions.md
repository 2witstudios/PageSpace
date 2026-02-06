# Review Vector: Lib Permissions Package

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
The lib permissions package exports the centralized RBAC functions that all API routes and services use to determine access levels for drives, pages, and workspace resources. Permission functions must be pure, composable, and return consistent access level types that callers can rely on. Review should ensure that permission escalation is impossible, that default-deny is maintained for unknown states, and that new permission rules integrate cleanly with existing access level hierarchies.
