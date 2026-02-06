# Review Vector: Page Agents

## Standards
- review.mdc
- javascript.mdc
- please.mdc
- agent-orchestrator.mdc

## Scope
**Files**: `apps/web/src/app/api/ai/page-agents/**`, `apps/web/src/components/ai/**`, `apps/web/src/stores/page-agents/**`
**Level**: domain

## Context
Page agents are per-page AI assistants with their own conversation history, custom instructions, and scoped tool access. The system manages agent lifecycle (creation, configuration, deletion), persists agent state, and renders agent-specific UI in the sidebar. Agent orchestration logic determines how agents receive page context and how their capabilities differ from the global assistant.
