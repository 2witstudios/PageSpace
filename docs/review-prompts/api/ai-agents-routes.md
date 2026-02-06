# Review Vector: AI Agents Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/ai/page-agents/**/route.ts`
**Level**: route

## Context
Page agent routes manage custom AI agents attached to pages: agent creation, configuration updates, conversation lifecycle (create, list, get, delete), message streaming within agent conversations, inter-agent consultation, and multi-drive agent queries. Agents have their own system prompts and tool access scoped to their page context. Permission checks must verify that the user has access to both the agent's parent page and any pages the agent tools reference, especially in multi-drive and consult scenarios where cross-boundary access is possible.
