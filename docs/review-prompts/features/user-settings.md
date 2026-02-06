# Review Vector: User Settings

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc

## Scope
**Files**: `apps/web/src/components/settings/**`, `apps/web/src/app/api/settings/**`, `apps/web/src/app/api/account/**`
**Level**: domain

## Context
User settings manage profile information, notification preferences, appearance options, and account security like password changes. API routes must validate that users can only modify their own settings and that sensitive operations like password changes require current password confirmation. The frontend settings components should provide immediate feedback on save operations and handle validation errors inline without losing unsaved changes in other sections.
