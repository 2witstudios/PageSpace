# Review Vector: Room Management

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `apps/realtime/src/**`, `apps/realtime/src/socket-registry.ts`
**Level**: service

## Context
The socket registry tracks which users are in which rooms and manages join/leave operations for page-level and drive-level collaboration. Review that room membership is correctly maintained on disconnect, that stale entries are cleaned up, and that broadcasting targets the correct room participants. Race conditions around rapid join/leave sequences deserve particular attention.
