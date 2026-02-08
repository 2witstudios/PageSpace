# Review Vector: Conversation State

## Standards
- review.mdc
- javascript.mdc
- please.mdc

## Scope
**Files**: `apps/web/src/app/api/ai/chat/**`, `apps/web/src/stores/page-agents/**`
**Level**: domain

## Context
Conversation state management handles message history persistence, message parts structure, optimistic UI updates, and synchronization between the client store and server-side chat records. The message format must consistently use the parts-based structure for content. State integrity is essential because corrupted conversation history causes context confusion and broken AI continuity.
