# Review Vector: System Prompts

## Standards
- review.mdc
- javascript.mdc
- please.mdc
- agent-orchestrator.mdc

## Scope
**Files**: `apps/web/src/lib/ai/**`
**Level**: service

## Context
System prompt construction assembles the base persona, injects page context, drive metadata, user preferences, and agent role instructions into the system message sent to the AI provider. The prompt builder must respect token budgets and prioritize the most relevant context. Changes to prompt construction directly affect AI response quality, tool usage accuracy, and agent behavior across all conversation types.
