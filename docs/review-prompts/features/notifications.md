# Review Vector: Notifications

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc
- realtime.mdc

## Scope
**Files**: `apps/web/src/components/notifications/**`, `apps/web/src/app/api/notifications/**`, `packages/lib/src/notifications/**`
**Level**: domain

## Context
The notification system spans in-app real-time alerts and email delivery, with shared logic in @pagespace/lib for determining notification triggers and recipient resolution. Notification creation must be efficient to avoid slowing down the originating action, and users must be able to configure preferences to control which events generate notifications. The frontend notification center handles read/unread state, grouping, and real-time updates via Socket.IO without overwhelming the user with excessive alerts.
