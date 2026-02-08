# Review Vector: Responsive Design

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/hooks/useBreakpoint.ts`, `apps/web/src/hooks/useMobile.ts`
**Level**: component

## Context
PageSpace uses useBreakpoint and useMobile hooks to detect viewport size and adapt the UI between desktop, tablet, and mobile layouts. These hooks drive decisions like sidebar visibility, tab bar rendering, and whether to show voice control buttons (hidden on mobile per a recent change). The hooks must avoid layout thrashing from frequent resize events and provide stable values that components can rely on without causing hydration mismatches between server and client rendering.
