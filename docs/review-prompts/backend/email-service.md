# Review Vector: Email Service

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- services.mdc

## Scope
**Files**: `packages/lib/src/email-templates/**`, `packages/lib/src/services/**`
**Level**: service

## Context
The email service manages transactional email delivery using templated content for invitations, notifications, and account-related communications. Templates must be reviewed for correct variable interpolation, proper escaping to prevent injection, and consistent branding. Service-layer integration should follow established patterns for error handling and retry logic.
