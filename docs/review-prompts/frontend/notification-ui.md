# Review Vector: Notification UI

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/components/notifications/**`, `apps/web/src/stores/useNotificationStore.ts`
**Level**: component

## Context
PageSpace displays notifications for real-time events like mentions, task assignments, page shares, and system alerts through components in the notifications directory backed by useNotificationStore. Notifications arrive via Socket.IO events and must be displayed, stacked, and dismissed without blocking the user's workflow. The store manages read/unread state, notification grouping, and badge counts that appear in the sidebar. Notification rendering must handle variable content lengths, action buttons, and links to specific pages or conversations without layout overflow.
