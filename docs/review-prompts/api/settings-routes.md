# Review Vector: Settings Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/settings/**/route.ts`
**Level**: route

## Context
Settings routes manage user-scoped application preferences: display preferences (theme, density, sidebar behavior), hotkey customization, notification delivery preferences (email, push, in-app toggles per event type), and personalization settings. These are strictly per-user endpoints that should only read and write the authenticated user's own preferences. The notification preferences endpoint controls which events generate notifications, so it must validate that the preference keys match known event types to prevent schema drift.
