# Review Vector: Environment Variables

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `.env*`, `packages/lib/src/config/**`
**Level**: cross-cutting

## Context
Environment variables configure database connections, API keys, service URLs, and feature flags across the monorepo. Review that all required variables are validated at startup with clear error messages for missing values, that secrets are never committed to version control or logged, and that the configuration layer provides typed access rather than raw `process.env` lookups scattered throughout the codebase.
