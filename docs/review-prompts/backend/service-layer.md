# Review Vector: Service Layer

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- services.mdc

## Scope
**Files**: `packages/lib/src/services/**`
**Level**: service

## Context
The service layer in packages/lib contains shared business logic consumed by the web app, processor, and realtime services. Services coordinate between repositories, external integrations, and domain rules while maintaining testability through dependency injection or explicit parameter passing. Review should ensure services remain stateless, properly propagate errors, and do not duplicate logic that belongs in repositories or utility functions.
