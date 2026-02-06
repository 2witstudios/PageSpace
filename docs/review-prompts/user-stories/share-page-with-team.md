# Review Vector: Share Page with Team

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/pages/[pageId]/permissions/route.ts`, `apps/web/src/app/api/pages/[pageId]/permissions/check/route.ts`, `packages/lib/src/permissions/permissions.ts`, `packages/lib/src/permissions/permission-mutations.ts`, `packages/lib/src/permissions/schemas.ts`, `packages/db/src/schema/permissions.ts`, `packages/lib/src/notifications/notifications.ts`, `packages/lib/src/services/notification-email-service.ts`, `packages/lib/src/email-templates/PageSharedEmail.tsx`, `apps/web/src/hooks/usePermissions.ts`, `apps/realtime/src/index.ts`
**Level**: domain

## Context
Sharing begins when the page owner opens the permissions dialog and adds a member with a specific role. The permissions API validates the caller's access level, writes the new permission record to the database, triggers a notification via the notification service, and sends a sharing email. The realtime service broadcasts the permission change so other connected clients update immediately. This journey crosses permission enforcement logic, database writes, notification creation, email delivery, and real-time event broadcasting.
