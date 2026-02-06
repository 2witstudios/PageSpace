# Review Vector: Layout System

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/app/**/layout.tsx`, `apps/web/src/components/layout/**`
**Level**: component

## Context
PageSpace uses Next.js 15 App Router nested layouts to compose the application shell including the left sidebar, main content area, right sidebar, header, and tab bar. Layout components manage responsive behavior, sidebar collapse states via useLayoutStore, and coordinate with the authentication boundary. Since layouts persist across navigations in the App Router model, any state or subscriptions initialized in layouts must handle route changes correctly without stale closures or memory leaks.
