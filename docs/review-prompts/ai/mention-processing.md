# Review Vector: Mention Processing

## Standards
- review.mdc
- javascript.mdc
- please.mdc

## Scope
**Files**: `apps/web/src/lib/mentions/**`, `apps/web/src/app/api/mentions/**`, `apps/web/src/hooks/useMentionOverlay.ts`
**Level**: domain

## Context
Mention processing detects @mention tokens in user messages, resolves them to pages, drives, or users, and injects the referenced content into the AI conversation context. The mention overlay hook provides autocomplete UI for selecting mention targets. Correct resolution is critical because unresolved or misresolved mentions cause the AI to hallucinate about non-existent content or miss relevant context entirely.
