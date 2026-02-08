# Review Vector: Code Duplication

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `apps/web/src/**`, `packages/**`
**Level**: cross-cutting

## Context
Shared logic belongs in `packages/lib` or `packages/db` rather than being duplicated across app-level code. Review for repeated patterns in API routes, utility functions, type definitions, and UI components that could be extracted into shared packages. Identify near-duplicates that have diverged slightly and may benefit from consolidation behind a common interface.
