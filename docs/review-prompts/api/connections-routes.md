# Review Vector: Connections Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/connections/**/route.ts`
**Level**: route

## Context
Connection routes manage user-to-user relationships: listing current connections, searching for users to connect with, creating connection requests, and removing existing connections. Connections enable direct messaging and calendar attendee selection. The search endpoint must not leak private user information to unauthenticated or unconnected users. Connection state changes should trigger notifications to the affected parties and must handle the bidirectional nature of connections so that removal by either party cleans up both sides.
