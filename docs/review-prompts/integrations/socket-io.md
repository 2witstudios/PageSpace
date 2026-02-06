# Review Vector: Socket.IO Integration

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- tdd.mdc

## Scope
**Files**: `apps/realtime/src/**`, `apps/web/src/lib/websocket/**`, `apps/web/src/hooks/useActivitySocket.ts`, `apps/web/src/hooks/useGlobalDriveSocket.ts`, `apps/web/src/hooks/useInboxSocket.ts`, `apps/web/src/stores/useSocketStore.ts`
**Level**: integration

## Context
The Socket.IO integration spans the dedicated realtime service and multiple client-side hooks that manage connection lifecycle, room membership, and event broadcasting. Client reconnection logic must handle token refresh, room rejoin, and missed-event recovery without duplicating state or triggering unnecessary re-renders. Event schemas between server emissions and client listeners should be type-safe and versioned to prevent silent desynchronization during deployments.
