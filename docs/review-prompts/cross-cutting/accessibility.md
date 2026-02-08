# Review Vector: Accessibility

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/components/**`
**Level**: cross-cutting

## Context
All interactive components must be usable via keyboard, announce state changes to screen readers, and meet WCAG 2.1 AA contrast and sizing requirements. Review that custom UI elements have appropriate ARIA roles, labels, and live regions, that focus management is handled correctly in modals, dropdowns, and navigation flows, and that shadcn/ui component customizations preserve the accessibility built into the base primitives.
