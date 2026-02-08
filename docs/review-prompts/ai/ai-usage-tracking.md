# Review Vector: AI Usage Tracking

## Standards
- review.mdc
- javascript.mdc
- please.mdc

## Scope
**Files**: `apps/web/src/app/api/ai/**`, `apps/web/src/app/api/pages/[pageId]/ai-usage/**`, `apps/web/src/hooks/useAiUsage.ts`
**Level**: domain

## Context
AI usage tracking records token consumption, model selection, and cost estimates per conversation, page, and user. The tracking logic runs in API route handlers after streaming completes and persists usage records to the database. Accurate tracking depends on correctly extracting token counts from provider responses, which vary in format across different AI SDK providers.
