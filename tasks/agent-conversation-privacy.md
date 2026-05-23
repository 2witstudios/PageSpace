# Agent Conversation Privacy Epic

**Status**: 🚧 IN PROGRESS
**Goal**: Make page-agent conversation history private to its creator by default, with an explicit opt-in to multiplayer (all drive members with page-view access).

## Overview

Users chatting with an AI agent expect their conversations to be private — today every drive member with view access sees every conversation ever started on a shared AI Chat page. This epic adds an `isShared` flag to conversations (default false = private), enforces user-scoped filtering throughout the stack, and adds a UI toggle so users can explicitly opt in to multiplayer collaboration on a conversation.

---

## Schema: Add isShared to conversations

Add `isShared boolean default false` to the `conversations` table and generate a migration.

**Requirements**:
- Given a new `isShared` column is added, should default to `false` for all future rows
- Given the migration runs on an existing database, should set `isShared = true` on all pre-existing `conversations` rows to preserve current drive-visible behaviour
- Given the schema changes, should generate a migration with `bun run db:generate` (never hand-edit SQL)

---

## Repository: Eager conversation creation

Change POST /conversations to immediately insert a `conversations` row (with `userId` and `isShared=false`) instead of the current lazy/title-only creation.

**Requirements**:
- Given a new conversation is created via POST, should insert a `conversations` row with `userId`, `type='page'`, `contextId=agentId`, `isShared=false`
- Given the `conversations` row is inserted, should use `ON CONFLICT DO NOTHING` so concurrent requests are safe
- Given the eager insert, should pass tests for the existing `upsertConversationTitle` path (no double-insert conflicts)

---

## Repository: User-scoped list and count

Update `listConversations` and `countConversations` to accept a `userId` parameter and filter to only the user's own conversations or explicitly shared ones.

**Requirements**:
- Given `userId` is passed, should return conversations where `conversations.userId = userId`
- Given a conversation is shared (`isShared = true`), should be visible to all users regardless of owner
- Given a legacy `chatMessages` row with no matching `conversations` row, should treat it as shared (LEFT JOIN null path)
- Given the filter is applied, should also apply to `countConversations` so pagination totals are correct

---

## Repository: setConversationShared + getConversation

Add two repository methods: `getConversation(conversationId)` for ownership lookup and `setConversationShared(conversationId, isShared)` to toggle the flag.

**Requirements**:
- Given `getConversation(id)`, should return the full `conversations` row or null if not found
- Given `setConversationShared(id, true)`, should update `isShared = true` for that row
- Given `setConversationShared(id, false)`, should update `isShared = false` for that row

---

## Route: GET /conversations — user-scoped

Pass `auth.userId` to `listConversations` and `countConversations`, and include `isShared` and `isOwner` in each response item.

**Requirements**:
- Given a request from User A, should return only User A's own conversations plus any shared conversations
- Given a shared conversation, should include `isShared: true` and `isOwner: false` for User B
- Given an owned conversation, should include `isOwner: true` for the creator

---

## Route: POST /conversations — eagerly persist + suppress broadcast

Call `createConversation()` in the repository after generating the ID, and remove the `broadcastAiConversationAdded` call (private conversations must not notify other users).

**Requirements**:
- Given a POST from User A, should persist the `conversations` row before returning
- Given the conversation is private (`isShared=false`), should NOT broadcast `chat:conversation_added` to the page channel
- Given the eager insert, should return the same `{ conversationId, title, createdAt }` shape as before

---

## Route: PATCH /conversations/[id] — isShared toggle + ownership

Extend the PATCH handler to accept `isShared` in the body, verify the requestor owns the conversation, and broadcast appropriately when sharing state changes.

**Requirements**:
- Given `isShared: true` in PATCH body, should set `isShared=true` and broadcast `chat:conversation_added` to the page channel so others see it
- Given `isShared: false` in PATCH body, should set `isShared=false` and broadcast `chat:conversation_deleted` so others' history panes remove it
- Given the requestor is not the conversation owner, should return 403 for `isShared` changes
- Given `title` in the body, should still work as before (no regression)

---

## Route: DELETE /conversations/[id] — ownership enforcement

Enforce that only the conversation owner (or a user with page-edit permission who is also a drive admin) can delete a conversation.

**Requirements**:
- Given the requestor owns the conversation, should soft-delete as before
- Given the requestor does not own the conversation but has page-edit permission, should still return 403 (edit permission is insufficient — only the owner may delete their own private history)
- Given the conversation is shared and the requestor is a drive admin, should allow deletion

---

## Route: Messages — access gate

Before returning messages for a conversation, verify the requestor can access it (owns it, it's shared, or it's legacy).

**Requirements**:
- Given the requestor owns the conversation, should return messages
- Given `isShared=true`, should return messages to any page-view-permitted user
- Given no `conversations` row exists (legacy), should return messages to any page-view-permitted user
- Given the requestor does not own a private conversation, should return 403

---

## Route: Chat message broadcast gate

In the AI chat route (`/api/ai/chat`), look up the conversation's `isShared` status before calling `broadcastChatUserMessage` and suppress the broadcast for private conversations.

**Requirements**:
- Given a private conversation, should skip `broadcastChatUserMessage` and `broadcastChatAssistantMessage` entirely
- Given a shared conversation, should broadcast as before
- Given a lookup failure (e.g. no `conversations` row), should broadcast as a safe default

---

## UI: Share toggle in History tab

Add a "Share" icon/toggle to each conversation row in the AiChatView History tab that calls PATCH with `{ isShared }`.

**Requirements**:
- Given the current user owns a conversation, should show a share toggle button on the conversation row
- Given the conversation is private (`isShared=false`), should show an unshared icon (e.g. lock icon)
- Given the conversation is shared (`isShared=true`), should show a shared indicator (e.g. people icon)
- Given the user clicks the toggle, should call PATCH and optimistically update the UI
- Given the user is not the owner, should not show the toggle button
