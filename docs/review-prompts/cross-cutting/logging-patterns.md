# Review Vector: Logging Patterns

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `packages/lib/src/logging/**`, `packages/lib/src/monitoring/**`, `apps/processor/src/logger.ts`
**Level**: cross-cutting

## Context
Logging spans the web app, processor service, and shared libraries, with centralized utilities for structured output and monitoring. Review that log levels are used appropriately, that sensitive data such as tokens, passwords, and user content is redacted before logging, and that log output is structured consistently across all services for aggregation.
