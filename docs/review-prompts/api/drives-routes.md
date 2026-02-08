# Review Vector: Drives Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/drives/**/route.ts`
**Level**: route

## Context
Drive routes manage workspace creation, configuration, member invitations, member role assignment and removal, custom role CRUD with reordering, backup creation, activity history, page listing per drive, permissions tree visualization, trash management, restore operations, assignee listing, agent configuration, and in-drive regex/glob search. Drives are the top-level organizational boundary and membership container, so role-based access control must be enforced consistently. Member management endpoints must prevent privilege escalation and ensure owners cannot be removed or downgraded.
