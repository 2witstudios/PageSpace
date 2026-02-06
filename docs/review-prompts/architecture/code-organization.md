# Review Vector: Code Organization

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `apps/web/src/**`, `packages/**`
**Level**: architectural

## Context
The codebase organizes code by feature within the web app (components/ai, components/editors, lib/auth, lib/billing, etc.) and by domain in shared packages (lib/permissions, lib/services, db/schema). Review whether the organizational structure consistently colocates related code, whether the split between apps/web and packages is principled, and whether there are files or modules that have drifted into the wrong directory or abstraction layer.
