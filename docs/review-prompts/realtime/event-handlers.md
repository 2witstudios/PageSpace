# Review Vector: Event Handlers

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `apps/realtime/src/**`
**Level**: service

## Context
Every Socket.IO event listener must validate its payload before acting on it, using the validation utilities in the realtime service. Review that all event handlers follow a consistent pattern of validation, authorization via per-event-auth, and error response. Ensure no handler silently swallows errors or trusts unvalidated client data.
