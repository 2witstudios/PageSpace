# AI Agent System Implementation TODO

## Overview
Transform AI_CHAT pages into discoverable, configurable agents with custom system prompts, descriptions, and tool permissions. Remove role-based system for AI_CHAT pages in favor of system prompt-defined behavior.

## Phase 1: Database Schema Updates
- [x] Add new columns to pages table for AI_CHAT configuration
  - [x] `aiSystemPrompt` TEXT - Custom system prompt defining agent behavior
  - [x] `aiDescription` TEXT - Agent description for discovery
  - [x] `aiToolAccess` JSONB - Restricted tool list (null = all tools)
  - [x] `aiModelOverride` TEXT - Optional model override
- [x] Create migration script for database changes (0002_brown_shotgun.sql)
- [x] Update Drizzle schema in `packages/db/src/schema/core.ts`

## Phase 2: System Prompt Injection
- [x] Modify `/api/ai/chat/route.ts` to inject custom system prompts
  - [x] Load `aiSystemPrompt` from pages table for AI_CHAT pages
  - [x] Replace RolePromptBuilder usage for AI_CHAT pages
  - [x] Use custom system prompt when available
  - [x] Handle tool restrictions via `aiToolAccess`
  - [x] Support `aiModelOverride` for agent-specific models
- [x] Remove agentRole dependency for AI_CHAT pages
  - [x] Keep roles only for global AI assistant (dashboard/sidebar)
  - [x] Remove role-based tool filtering for AI_CHAT pages
  - [x] Use explicit `aiToolAccess` list instead

## Phase 3: Agent Discovery System
- [x] Create `discover_agents` tool
  - [x] Find AI_CHAT pages with descriptions
  - [x] Return permission-filtered results
  - [x] Include relevance scoring based on query
- [x] Create `invoke_agent` tool  
  - [x] Accept agentId, query, and optional context
  - [x] Prepare for temporary chat session with target agent
  - [ ] TODO: Implement full streaming chat session
- [x] Add tools to `/lib/ai/tools/agent-tools.ts`
- [x] Export tools in `/lib/ai/ai-tools.ts`

## Phase 4: Page Creation Updates
- [x] Update `/api/pages/route.ts` POST endpoint
  - [x] Accept `aiSystemPrompt`, `aiDescription`, `aiToolAccess`, `aiModelOverride`
  - [x] Store configuration in new database columns
- [x] Update `/api/drives/[driveId]/pages/route.ts` similarly
  - [x] Added Zod schema validation for new fields

## Phase 5: UI Components
- [x] Update `AiChatView.tsx` component
  - [x] Remove RoleSelector for AI_CHAT pages
  - [x] Remove agentRole state management
- [x] Create `AgentSettings.tsx` component
  - [x] System prompt editor
  - [x] Description field for agent discovery
  - [x] Tool access permission checkboxes
  - [x] Model override option
  - [x] Save functionality to PATCH endpoint
- [x] Update PATCH endpoint schema
  - [x] Added AI agent configuration fields to patchSchema

## Phase 6: Global AI Integration
- [ ] Update global AI assistant contexts
  - [ ] Keep PARTNER/PLANNER/WRITER roles for global only
  - [ ] Add agent discovery capability to global AI
  - [ ] Implement agent orchestration logic
- [ ] Update `AssistantChatTab.tsx` and `GlobalAssistantView.tsx`
  - [ ] Keep role selector for these contexts
  - [ ] Add agent consultation indicators

## Phase 7: Migration & Cleanup
- [ ] Remove `agentRole` from chat_messages table
- [ ] Remove role-related code from AI_CHAT contexts
- [ ] Update documentation
- [ ] Create migration guide for existing AI_CHAT pages

## Testing Checklist
- [ ] System prompt injection works correctly
- [ ] Agent discovery returns appropriate results
- [ ] Inter-agent communication functions properly
- [ ] Permissions are correctly enforced
- [ ] Tool restrictions work as expected
- [ ] UI updates reflect changes immediately
- [ ] Existing AI_CHAT pages continue to work

## Documentation
- [ ] Update CLAUDE.md with agent system information
- [ ] Create user guide for agent configuration
- [ ] Document agent discovery and invocation
- [ ] Add examples of specialized agent prompts

## Notes
- Database-first approach: System prompts stored as first message
- AI_CHAT pages become specialized agents through configuration
- Global AI keeps role system for general assistance
- Agents inherit permissions from their location in hierarchy

## Current Status
**Date Started:** 2025-08-28
**Last Updated:** 2025-08-28
**Current Phase:** Phase 5 Complete - Core Implementation Done
**Blockers:** None

## Implementation Summary
✅ Database schema updated with AI agent configuration fields
✅ System prompt injection implemented in chat API
✅ Agent discovery and invocation tools created
✅ Page creation endpoints accept agent configuration
✅ UI updated to remove role selector from AI_CHAT pages
✅ Agent settings component created

## Next Steps
- Integrate AgentSettings component into AiChatView
- Test agent discovery and invocation
- Implement full streaming chat session for invoke_agent tool
- Add agent discovery UI for global assistant

---
*This document tracks the implementation of the AI Agent System in PageSpace*