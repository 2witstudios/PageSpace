# Review Vector: Send Direct Message

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/channels/[pageId]/messages/route.ts`, `apps/web/src/app/api/channels/[pageId]/messages/[messageId]/reactions/route.ts`, `apps/web/src/app/api/channels/[pageId]/read/route.ts`, `apps/web/src/app/api/channels/[pageId]/upload/route.ts`, `apps/web/src/hooks/useInboxSocket.ts`, `apps/web/src/lib/websocket/ws-connections.ts`, `apps/realtime/src/index.ts`, `packages/db/src/schema/chat.ts`, `packages/lib/src/notifications/notifications.ts`, `packages/lib/src/email-templates/DirectMessageEmail.tsx`
**Level**: domain

## Context
The direct messaging journey starts when a user opens a channel page and types a message, which POSTs to the channel messages API. The message is persisted to the chat schema in the database and broadcast via Socket.IO through the realtime service to all connected participants. The recipient's inbox socket hook receives the event and updates the UI in real-time, while a notification is created and optionally an email is sent for offline recipients. This flow spans the messaging API, database persistence, real-time WebSocket broadcasting, notification creation, email delivery, and frontend socket event handling.
