# Review Vector: Member Management

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc
- permissions.mdc

## Scope
**Files**: `apps/web/src/components/members/**`, `apps/web/src/app/api/drives/[driveId]/members/**`
**Level**: domain

## Context
Member management handles invitations, role assignment, and removal of users from drives, with cascading permission effects. The API routes must validate that the acting user has sufficient drive-level authority to modify membership and that role assignments respect the role hierarchy. Invitation flows include email delivery and acceptance workflows that must handle edge cases like expired invitations and duplicate invites gracefully.
