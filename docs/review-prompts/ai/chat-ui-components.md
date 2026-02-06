# Review Vector: Chat UI Components

## Standards
- review.mdc
- javascript.mdc
- please.mdc
- ui.mdc

## Scope
**Files**: `apps/web/src/components/ai/**`
**Level**: component

## Context
The chat UI components render the conversation interface including message bubbles, input composer, model selector, and streaming indicators. These components consume Zustand stores and SWR hooks and must correctly integrate with the editing store to prevent refresh disruption during active conversations. Accessibility and responsive behavior are important since the chat panel operates in a constrained sidebar layout.
