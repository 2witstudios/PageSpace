# Review Vector: Loading States

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/app/**/loading.tsx`, `apps/web/src/components/shared/**`
**Level**: component

## Context
Next.js 15 App Router uses loading.tsx files for Suspense-based route loading states, and PageSpace extends this with shared skeleton and spinner components used throughout the application. Loading states must provide meaningful visual feedback that matches the layout of the content being loaded to prevent layout shift. SWR-driven components have their own loading states separate from route-level Suspense, and the interaction between these two loading mechanisms can produce flickering or redundant loading indicators if not coordinated.
