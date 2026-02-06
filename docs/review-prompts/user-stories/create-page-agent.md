# Review Vector: Create Page Agent

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/ai/page-agents/create/route.ts`, `apps/web/src/app/api/ai/page-agents/[agentId]/config/route.ts`, `apps/web/src/app/api/ai/page-agents/[agentId]/conversations/route.ts`, `apps/web/src/app/api/ai/page-agents/[agentId]/conversations/[conversationId]/messages/route.ts`, `apps/web/src/app/api/pages/[pageId]/agent-config/route.ts`, `apps/web/src/components/ai/page-agents/PageAgentSettingsTab.tsx`, `apps/web/src/components/ai/page-agents/PageAgentConversationRenderer.tsx`, `apps/web/src/lib/ai/shared/hooks/useConversations.ts`, `apps/web/src/stores/page-agents/usePageAgentDashboardStore.ts`, `packages/db/src/schema/conversations.ts`
**Level**: domain

## Context
The page agent journey starts with creating an agent via the create route, which inserts an agent record linked to a specific page. The user then configures the agent's system prompt, model, and tool access through the config route and settings UI. Conversations are initiated through the conversations API, and messages flow through the dedicated message route with agent-specific context injection. This flow spans agent creation APIs, configuration persistence, conversation state management via Zustand stores, the AI streaming pipeline, and database schema across the conversations and AI tables.
