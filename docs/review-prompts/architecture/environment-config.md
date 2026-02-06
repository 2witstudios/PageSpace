# Review Vector: Environment Configuration

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `.env*`, `apps/web/src/lib/config/**`, `packages/lib/src/config/**`
**Level**: architectural

## Context
PageSpace runs across multiple services (web, realtime, processor) that each need environment configuration for database connections, API keys, auth secrets, and service URLs. Review whether environment variables are validated at startup, whether secrets are properly separated from non-sensitive config, and whether there is a single source of truth for configuration that prevents drift between services.
