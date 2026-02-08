# Review Vector: Theme System

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/app/globals.css`, `apps/web/tailwind.config.*`
**Level**: component

## Context
PageSpace uses Tailwind CSS v4 with CSS custom properties for theming, supporting light and dark modes through shadcn/ui's theme system. The globals.css file defines color tokens, typography scales, and component-level style overrides that the entire application consumes. Theme switching must work without flash of unstyled content, and all custom components must use theme tokens rather than hardcoded colors. The canvas dashboard feature uses Shadow DOM isolation, so theme variables must be explicitly passed through or re-declared within shadow boundaries.
