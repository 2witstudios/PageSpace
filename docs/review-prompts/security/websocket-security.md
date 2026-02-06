# Review Vector: WebSocket Security

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- security.mdc

## Scope
**Files**: `apps/realtime/src/**`, `apps/realtime/src/per-event-auth.ts`, `apps/realtime/src/validation.ts`
**Level**: service

## Context
The realtime service uses Socket.IO with per-event authentication and message validation to provide live collaboration features. Review the connection handshake authentication, whether JWT validation occurs on every event or only at connection time, and how room authorization prevents users from subscribing to rooms they lack access to. Examine the message validation layer for completeness and whether malformed or oversized payloads are rejected before processing. Assess whether the per-event auth implementation re-checks permissions that may have changed since connection establishment.
