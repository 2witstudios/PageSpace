# Review Vector: Google Calendar Integration

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc
- security.mdc

## Scope
**Files**: `apps/web/src/app/api/integrations/**`, `apps/web/src/lib/integrations/**`, `packages/lib/src/integrations/**`
**Level**: domain

## Context
Google Calendar integration uses OAuth 2.0 to connect external calendars, requiring secure token storage, refresh token rotation, and proper scope management. The sync logic must handle bidirectional event updates, conflict resolution when events are modified on both sides, and graceful degradation when the Google API is unavailable. OAuth callback routes must validate state parameters to prevent CSRF attacks, and stored refresh tokens must be encrypted at rest.
