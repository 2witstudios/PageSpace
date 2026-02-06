# Review Vector: Channels & Messaging Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/channels/**/route.ts`, `apps/web/src/app/api/messages/**/route.ts`
**Level**: route

## Context
Channel routes handle real-time messaging within page-scoped channels: posting messages, listing message history, file uploads within channels, emoji reactions, and read-receipt tracking. Message routes manage direct messaging through conversations and threads. Both systems emit Socket.IO events for live updates, so the API must validate membership before broadcasting. Message content supports rich formatting and file attachments, requiring proper sanitization and size limits.
