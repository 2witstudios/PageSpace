# Review Vector: Audit Logging

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- security.mdc

## Scope
**Files**: `packages/lib/src/audit/**`, `packages/lib/src/monitoring/**`, `apps/web/src/app/api/activities/**`
**Level**: service

## Context
Security-relevant events such as login attempts, permission changes, and administrative actions should be recorded in an audit trail that supports incident investigation and compliance. Review whether the audit logging implementation captures sufficient detail (actor, action, target, timestamp, outcome) for security events, whether logs are tamper-resistant, and whether sensitive data is inadvertently written into log entries. Examine the completeness of audit coverage across authentication, authorization, and data mutation operations.
