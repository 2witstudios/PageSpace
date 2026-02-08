# Review Vector: Global Conversations

## Standards
- review.mdc
- javascript.mdc
- please.mdc

## Scope
**Files**: `apps/web/src/app/api/ai/global/**`
**Level**: domain

## Context
Global conversations operate outside the scope of any single page, providing a workspace-level AI assistant that can search across drives, answer general questions, and perform cross-page operations. The global chat API routes manage their own conversation persistence and must resolve permissions at the drive level rather than the page level. These routes share the streaming and tool-calling infrastructure with page-scoped agents but differ in context assembly and available tools.
