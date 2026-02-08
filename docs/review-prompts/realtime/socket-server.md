# Review Vector: Socket Server

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `apps/realtime/src/**`
**Level**: service

## Context
The realtime service runs a standalone Socket.IO server on port 3001 that handles all live collaboration features. Review the server bootstrap, connection lifecycle, graceful shutdown, and configuration for correctness and resilience. Ensure the server properly validates authentication tokens on connection and handles transport upgrades cleanly.
