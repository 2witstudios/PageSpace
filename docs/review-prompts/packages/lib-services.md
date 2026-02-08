# Review Vector: Lib Services Package

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- services.mdc

## Scope
**Files**: `packages/lib/src/services/**`
**Level**: service

## Context
The lib services package contains shared business logic modules used across the web app, processor, and realtime services including email delivery, subscription management, and domain operations. Services must remain stateless and framework-agnostic to support consumption from multiple deployment targets. Review should verify that services use repository abstractions rather than direct database access, handle errors with structured result types, and do not introduce circular dependencies between packages.
