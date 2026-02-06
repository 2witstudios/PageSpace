# Review Vector: Right Sidebar

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- ui.mdc

## Scope
**Files**: `apps/web/src/components/layout/**`
**Level**: component

## Context
The right sidebar serves as a contextual details panel that displays page metadata, version history, task details, member information, or AI assistant settings depending on the current context. It must respond to layout store state changes for open/close toggling and resize correctly across breakpoints. The panel shares horizontal space with the main content area, so its visibility and width directly affect the editor and canvas rendering areas.
