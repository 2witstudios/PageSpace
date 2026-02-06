# Review Vector: Role System

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc
- permissions.mdc

## Scope
**Files**: `apps/web/src/app/api/drives/[driveId]/roles/**`
**Level**: domain

## Context
The role system supports custom roles with configurable permissions and explicit ordering to establish a role hierarchy within each drive. Role mutations must prevent privilege escalation where a user assigns permissions beyond their own access level. The ordering system determines which roles can manage which other roles, and default system roles must remain protected from deletion or dangerous modification.
