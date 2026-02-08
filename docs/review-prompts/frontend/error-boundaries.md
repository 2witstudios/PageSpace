# Review Vector: Error Boundaries

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/app/**/error.tsx`
**Level**: component

## Context
Next.js 15 App Router uses error.tsx files as React error boundaries at each route segment, catching runtime errors and rendering fallback UI with retry capabilities. PageSpace needs error boundaries at multiple levels to prevent a failure in one component from crashing the entire application shell. Error boundaries must be client components that provide useful error information for debugging while not leaking sensitive details to users, and they should offer meaningful recovery actions like retry or navigation back to a safe state.
