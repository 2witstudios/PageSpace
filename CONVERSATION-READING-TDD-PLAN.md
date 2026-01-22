# TDD Plan: Read Past Conversations Feature

## Overview

Enable AI to read past conversations and conversations with other chats (with proper access). This includes:
- Reading conversation history with line-range support
- Searching across conversations with regex/grep
- Multi-AI conversation attribution (tracking which AI sent a message)

## Design Decisions

| Decision | Choice |
|----------|--------|
| Tool location | `page-read-tools.ts` |
| Test style | Riteway `assert({ given, should, actual, expected })` |
| Search default | `['documents', 'conversations']` - no backward compat |
| Conversation ownership | Receiver (target agent) owns the conversation |
| Access scope | Any conversation the AI has access to |

---

## Implementation Phases

### Phase 1: Schema Change

**Add `sourceAgentId` to `chatMessages` table**

```typescript
// packages/db/src/schema/core.ts
sourceAgentId: text('source_agent_id').references(() => pages.id, { onDelete: 'set null' }),
```

Purpose: Track which AI agent sent a message (null = direct user message)

---

### Phase 2: `read_page` Line Range Support

**File:** `apps/web/src/lib/ai/tools/page-read-tools.ts`

#### Functional Requirements

| # | Given | Should |
|---|-------|--------|
| 2.1 | read_page with no line params | return full content |
| 2.2 | read_page with lineStart=3, lineEnd=5 | return only lines 3-5 |
| 2.3 | read_page with lineStart only | return from lineStart to end |
| 2.4 | read_page with lineEnd only | return from start to lineEnd |
| 2.5 | lineStart > total lines | return empty with message |
| 2.6 | lineEnd > total lines | return from lineStart to actual end |
| 2.7 | lineStart > lineEnd | return error |
| 2.8 | negative line numbers | return error |

---

### Phase 3: `list_conversations` Tool

**File:** `apps/web/src/lib/ai/tools/page-read-tools.ts`

#### API Shape

```typescript
list_conversations({
  pageId: string,    // AI_CHAT page to list conversations for
  title: string,     // Display title
})

// Returns
{
  success: true,
  pageId: string,
  pageTitle: string,
  conversations: [{
    conversationId: string,
    messageCount: number,
    lastActivity: string,        // ISO timestamp
    firstMessagePreview: string, // Truncated first message
    participants: string[],      // userIds involved
  }]
}
```

#### Functional Requirements

| # | Given | Should |
|---|-------|--------|
| 3.1 | unauthenticated user | throw auth error |
| 3.2 | user without page access | throw permission error |
| 3.3 | valid AI_CHAT pageId | return conversation list with metadata |
| 3.4 | AI_CHAT with no conversations | return empty array |
| 3.5 | non-AI_CHAT page | return error |

---

### Phase 4: `read_conversation` Tool

**File:** `apps/web/src/lib/ai/tools/page-read-tools.ts`

#### API Shape

```typescript
read_conversation({
  pageId: string,         // AI_CHAT page
  conversationId: string, // Specific conversation
  title: string,          // Display title
  lineStart?: number,     // 1-indexed message start
  lineEnd?: number,       // 1-indexed message end (inclusive)
})

// Returns
{
  success: true,
  pageId: string,
  conversationId: string,
  content: string,        // Formatted messages with line numbers
  messageCount: number,   // Total in conversation
  rangeStart: number,     // Actual start returned
  rangeEnd: number,       // Actual end returned
}

// Content format:
// 1→[user] Hello, can you help?
// 2→[assistant] Sure! What do you need?
// 3→[user@Global Assistant] Check conversation X for context
// 4→[assistant] Found relevant info...
```

#### Functional Requirements

| # | Given | Should |
|---|-------|--------|
| 4.1 | unauthenticated user | throw auth error |
| 4.2 | user without page access | throw permission error |
| 4.3 | invalid conversationId | return error |
| 4.4 | valid request, no line params | return all messages |
| 4.5 | lineStart/lineEnd specified | return only messages in range |
| 4.6 | direct user message | format as `[user]` |
| 4.7 | assistant message | format as `[assistant]` |
| 4.8 | message with sourceAgentId | format as `[user@AgentTitle]` |
| 4.9 | lineStart > total messages | return empty with message |

---

### Phase 5: Extend `search_pages` for Conversations

**File:** `apps/web/src/lib/ai/tools/search-tools.ts`

#### API Change

```typescript
regex_search({
  driveId: string,
  pattern: string,
  searchIn: 'title' | 'content' | 'both',
  maxResults: number,
  contentTypes?: ('documents' | 'conversations')[], // NEW - defaults to both
})

// Result for conversation match:
{
  pageId: string,
  pageTitle: string,
  type: 'AI_CHAT',
  conversationId: string,      // NEW
  lineNumber: number,          // Message index
  matchPreview: string,
  suggestedLineRange: {        // NEW
    start: number,
    end: number
  }
}
```

#### Functional Requirements

| # | Given | Should |
|---|-------|--------|
| 5.1 | regex_search with default params | search both documents AND conversations |
| 5.2 | contentTypes=['documents'] | search only documents |
| 5.3 | contentTypes=['conversations'] | search only conversations |
| 5.4 | conversation match | return pageId, conversationId, lineNumber |
| 5.5 | conversation match | include suggestedLineRange for context |

---

### Phase 6: Update `ask_agent` for Source Attribution

**File:** `apps/web/src/lib/ai/tools/agent-communication-tools.ts`

#### Functional Requirements

| # | Given | Should |
|---|-------|--------|
| 6.1 | ask_agent from AI_CHAT context | save sourceAgentId as calling page's id |
| 6.2 | ask_agent from non-AI context | save sourceAgentId as null |
| 6.3 | saved user message | include sourceAgentId field |
| 6.4 | response includes attribution | metadata shows source |

---

## TDD Process

For each phase:

1. **RED**: Write failing test with Riteway assert pattern
2. **GREEN**: Implement minimal code to pass
3. **REFACTOR**: Clean up while keeping tests green
4. Get user approval before moving to next requirement

---

## File Locations

- Schema: `packages/db/src/schema/core.ts`
- Tools: `apps/web/src/lib/ai/tools/page-read-tools.ts`
- Search: `apps/web/src/lib/ai/tools/search-tools.ts`
- Agent comms: `apps/web/src/lib/ai/tools/agent-communication-tools.ts`
- Tests: `apps/web/src/lib/ai/tools/__tests__/*.test.ts`
