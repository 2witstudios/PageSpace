# Review Vector: SWR Data Fetching

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/hooks/**`, `apps/web/src/components/**`
**Level**: component

## Context
SWR is the server state and caching layer throughout PageSpace, used in hooks and components for fetching pages, drives, members, and other resources. All SWR usage must integrate with the editing store's refresh protection: using isPaused to block revalidation during active editing or AI streaming, while ensuring initial fetches are never blocked via a hasLoadedRef pattern. Cache key conventions, deduplication, mutate calls for optimistic updates, and proper error/loading state handling are all areas where subtle bugs can emerge.
