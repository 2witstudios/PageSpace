# Review Vector: Broadcast API

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `apps/realtime/src/**`, `apps/web/src/lib/websocket/**`
**Level**: service

## Context
The web app communicates with the realtime service through a websocket client layer that mirrors the server-side event contract. Review that event names and payload shapes are consistent between the two services, that the web client handles reconnection and missed events gracefully, and that broadcast messages are not echoed back to the sender unnecessarily.
