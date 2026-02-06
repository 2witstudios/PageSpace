# Review Vector: Service Boundaries

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `apps/web/src/lib/websocket/**`, `apps/realtime/src/**`, `apps/processor/src/**`
**Level**: architectural

## Context
Three services communicate at runtime: the web app talks to the realtime service via Socket.IO for live collaboration, and to the processor service via HTTP for file processing and content extraction. Review whether the communication contracts between services are well-defined, whether failure in one service is gracefully handled by the others, and whether the boundaries between services are clean enough that each could be deployed and scaled independently.
