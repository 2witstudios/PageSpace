# Review Vector: Build System

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `turbo.json`, `*/tsconfig.json`, `*/package.json`
**Level**: architectural

## Context
Turbo orchestrates builds across the monorepo, managing pipeline dependencies, caching, and TypeScript compilation order. Review whether the Turbo pipeline correctly declares task dependencies and inputs/outputs for cache invalidation, whether tsconfig extends chains are consistent, and whether the build order guarantees that shared packages compile before dependent apps.
