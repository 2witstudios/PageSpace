# Review Vector: Public & Utility Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/compiled-css/route.ts`, `apps/web/src/app/api/avatar/**/route.ts`, `apps/web/src/app/api/debug/**/route.ts`, `apps/web/src/app/api/feedback/**/route.ts`, `apps/web/src/app/api/contact/**/route.ts`, `apps/web/src/app/api/track/**/route.ts`, `apps/web/src/app/api/trash/**/route.ts`
**Level**: route

## Context
This group covers utility and lower-privilege routes: compiled CSS serving for canvas pages (must sanitize to prevent CSS injection), avatar image serving by user ID, debug endpoints for chat message inspection, user feedback submission, public contact form, analytics event tracking, and trash management (permanent deletion and per-drive trash listing). The avatar route serves images without full auth to support embedding in emails and external contexts, so it must prevent path traversal. Debug routes must be restricted to development or admin access. Trash deletion is irreversible and must require explicit confirmation and proper ownership verification.
