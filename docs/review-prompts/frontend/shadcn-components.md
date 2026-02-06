# Review Vector: shadcn/ui Components

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc
- stack.mdc

## Scope
**Files**: `apps/web/src/components/ui/**`
**Level**: component

## Context
PageSpace uses shadcn/ui as its component library foundation, with components generated into components/ui/ and customized for the application's design system. Customizations include theme-aware styling via CSS variables, extended variants, and composition with Radix UI primitives. Components must maintain accessibility attributes from the upstream Radix primitives, support dark/light theme switching, and follow the project's Tailwind v4 conventions. Any divergence from shadcn/ui defaults should be intentional and documented since component updates from upstream may need manual merging.
