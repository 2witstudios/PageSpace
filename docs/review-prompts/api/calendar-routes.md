# Review Vector: Calendar & Integrations Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/calendar/**/route.ts`, `apps/web/src/app/api/integrations/**/route.ts`
**Level**: route

## Context
Calendar routes manage event CRUD and attendee management for PageSpace's built-in calendar system. Integration routes handle the Google Calendar OAuth connection flow (connect, callback, disconnect), sync status checks, and bidirectional sync triggers. The OAuth callback must securely store refresh tokens and handle token expiration gracefully. Calendar events support attendees from the user's connections, so permission boundaries between personal and shared calendars need careful validation.
