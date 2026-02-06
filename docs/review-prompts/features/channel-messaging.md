# Review Vector: Channel Messaging

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc
- realtime.mdc

## Scope
**Files**: `apps/web/src/components/messages/**`, `apps/web/src/app/api/channels/**`
**Level**: domain

## Context
Channel messaging provides real-time group communication within drives, coordinating between REST API endpoints for persistence and Socket.IO for live delivery. Messages must be persisted through the API before being broadcast via the realtime service to ensure no message loss on connection interruptions. The frontend must handle message ordering, optimistic sends, and reconnection scenarios while maintaining scroll position and unread indicators.
