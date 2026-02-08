# Review Vector: Receive Notifications

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/notifications/route.ts`, `apps/web/src/app/api/notifications/[id]/read/route.ts`, `apps/web/src/app/api/notifications/read-all/route.ts`, `packages/lib/src/notifications/notifications.ts`, `packages/lib/src/notifications/guards.ts`, `packages/lib/src/notifications/push-notifications.ts`, `apps/web/src/components/notifications/NotificationBell.tsx`, `apps/web/src/components/notifications/NotificationDropdown.tsx`, `apps/web/src/stores/useNotificationStore.ts`, `apps/web/src/hooks/useInboxSocket.ts`, `packages/db/src/schema/notifications.ts`
**Level**: domain

## Context
The notification journey is triggered by an upstream action (page share, task assignment, message) which calls the notification service to create a notification record in the database. The realtime service broadcasts the event, and the inbox socket hook on the frontend receives it, incrementing the unread count in the notification Zustand store. The NotificationBell component displays the badge, and clicking it opens the NotificationDropdown which fetches the full list. Marking as read PATCHes via the notification API. This flow crosses the notification creation service, database writes, real-time broadcasting, frontend socket listeners, Zustand state management, and API route handlers.
