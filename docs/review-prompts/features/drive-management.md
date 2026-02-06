# Review Vector: Drive Management

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc
- permissions.mdc

## Scope
**Files**: `apps/web/src/app/api/drives/**`, `apps/web/src/components/dialogs/**`
**Level**: domain

## Context
Drive management covers creation, settings configuration, and backup/restore operations for workspace drives. API routes enforce that only drive owners or admins can modify drive settings, and backup/restore must handle large datasets without timeouts or memory exhaustion. The frontend dialogs coordinate multi-step workflows for drive creation and settings changes with proper validation and error feedback.
