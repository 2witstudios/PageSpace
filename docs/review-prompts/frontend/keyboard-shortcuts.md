# Review Vector: Keyboard Shortcuts

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/lib/hotkeys/**`, `apps/web/src/stores/useHotkeyStore.ts`, `apps/web/src/hooks/useHotkeyPreferences.ts`
**Level**: component

## Context
PageSpace implements a keyboard shortcut system through lib/hotkeys/ with centralized registration in useHotkeyStore and user-customizable bindings via useHotkeyPreferences. Shortcuts must not conflict with browser defaults or editor keybindings when the TipTap or Monaco editor is focused. The hotkey system needs to handle modifier key differences across operating systems, prevent shortcuts from firing inside text inputs unless explicitly intended, and correctly clean up listeners when components unmount or shortcuts are rebound.
