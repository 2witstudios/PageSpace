# Review Vector: Direct Messages

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- api-routes.mdc
- realtime.mdc

## Scope
**Files**: `apps/web/src/components/messages/**`, `apps/web/src/app/api/messages/**`
**Level**: domain

## Context
Direct messages enable private one-on-one conversations between users, with thread support for organized replies. The API must enforce that only conversation participants can read or send messages, and the realtime integration must route DM events exclusively to the intended recipient. Shared message components between channels and DMs should maintain consistent behavior while respecting the different permission and routing models.
