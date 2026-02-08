# Review Vector: Dialogs and Modals

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/components/dialogs/**`, `apps/web/src/components/ui/dialog*`
**Level**: component

## Context
PageSpace uses shadcn/ui dialog primitives extended with custom dialog components for confirmations, page creation, drive settings, member invitations, sharing, and more. Dialogs must handle focus trapping, keyboard dismissal, and accessibility requirements from the underlying Radix primitives. State management for dialog open/close can live in local component state or be driven by URL parameters and Zustand stores, and the pattern chosen affects whether dialog state survives navigation.
