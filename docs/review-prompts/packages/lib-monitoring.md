# Review Vector: Lib Monitoring Package

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- monitoring.mdc

## Scope
**Files**: `packages/lib/src/monitoring/**`, `packages/lib/src/logging/**`
**Level**: service

## Context
The monitoring and logging modules provide structured observability across all services including request tracing, error reporting, performance metrics, and audit logging. Logging must use consistent formats and severity levels to support aggregation and alerting. Review should confirm that sensitive data is never logged, that log levels are appropriate for the context, and that monitoring instrumentation does not introduce meaningful performance overhead.
