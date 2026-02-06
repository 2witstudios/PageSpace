# Review Vector: Notification Service

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- services.mdc

## Scope
**Files**: `packages/lib/src/notifications/**`, `packages/lib/src/services/**`
**Level**: service

## Context
The notification service orchestrates in-app and external notifications triggered by user actions, system events, and collaboration activity. It coordinates with the email service for delivery and must respect user notification preferences. Review should focus on event routing correctness, delivery guarantees, and ensuring notifications are never sent for unauthorized content access.
