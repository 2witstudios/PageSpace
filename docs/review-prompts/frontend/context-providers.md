# Review Vector: Context Providers

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/components/providers/**`, `apps/web/src/app/**/layout.tsx`
**Level**: component

## Context
PageSpace wraps the application in multiple React context providers located in components/providers/ and composed in root and nested layouts. These providers supply theme configuration, authentication state, socket connections, SWR configuration, and dashboard context. Provider ordering matters because some providers depend on values from parent providers, and incorrect nesting can cause runtime errors or missing context. Over-providing at the root level can also cause unnecessary re-renders when provider values change frequently.
