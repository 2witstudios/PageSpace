# Review Vector: Dead Code

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `apps/web/src/**`, `packages/**`
**Level**: cross-cutting

## Context
Over time, refactoring and feature changes leave behind unused exports, unreachable branches, and orphaned files that increase cognitive load and bundle size. Review for functions and components that are exported but never imported elsewhere, feature flags or conditional paths that are permanently resolved, and test fixtures or utilities that no longer correspond to active code.
