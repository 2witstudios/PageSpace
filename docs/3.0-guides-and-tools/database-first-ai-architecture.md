# Database-First AI Architecture

## Overview

PageSpace implements a **database-first AI message architecture** that fundamentally differs from the standard Vercel AI SDK v5 patterns. This architectural decision enables multi-user collaboration, message persistence, editability, and cross-conversation search capabilities that are critical for PageSpace's workspace-oriented approach.

## Why Database-First?

### Core Requirements

PageSpace's AI system is designed for **collaborative workspaces**, not single-user chat applications. This requires:

1. **Multi-User Collaboration**: Multiple users can participate in the same AI conversation simultaneously
2. **Message Persistence**: Every message is an immutable database entity with full history
3. **Permission-Based Access**: AI context is filtered based on user permissions
4. **Cross-Conversation Search**: Messages are queryable across the entire workspace
5. **Hierarchical Context**: AI conversations inherit context from their page location
6. **Real-Time Sync**: All users see identical state from the database source of truth
7. **Message Editability**: Support for editing and regenerating messages
8. **Tool Call Auditing**: Complete audit trail of AI tool executions and results

### AI SDK v5 Standard Pattern (In-Memory)

The Vercel AI SDK v5 is designed for typical single-user chat applications:

```typescript
// Standard AI SDK Pattern (most apps):
const { messages, sendMessage } = useChat({
  api: '/api/chat',
  initialMessages: [], // Empty or loaded once
});

// Server receives messages from client
export async function POST(request: Request) {
  const { messages } = await request.json();

  // Use messages directly from client
  const result = await streamText({
    messages: convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
```

**This works when:**
- Single user per conversation
- No external message edits
- No collaborative features
- Client state is the source of truth
- No multi-user synchronization needed

### PageSpace's Deviation (Database-First)

PageSpace treats messages as **collaborative workspace entities**:

```typescript
// PageSpace Pattern (Database-First):
// 1. Every message is a database row
// 2. Database is ALWAYS source of truth
// 3. Client state is just a view layer
// 4. Multiple users share same database rows
// 5. Edits are immediately visible to all users
```

## Architectural Comparison

| Aspect | AI SDK v5 (Standard) | PageSpace (Database-First) |
|--------|---------------------|----------------------------|
| **State Management** | Client-side (useChat hook) | Database (PostgreSQL) |
| **Source of Truth** | Client memory | Database rows |
| **Collaboration** | Single user | Multi-user simultaneous |
| **Message Persistence** | Optional (bulk save) | Mandatory (immediate save) |
| **Editability** | Client state mutation | Database updates with versioning |
| **Search** | Not supported | Full-text search across all messages |
| **Permissions** | Not applicable | Fine-grained, per-message access control |
| **Tool Integration** | Basic | Advanced (33+ workspace tools) |
| **Context Awareness** | None | Hierarchical page context |

## Database Schema

### Global AI Messages (`messages` table)

```sql
messages (
  id: text PRIMARY KEY,
  conversationId: text REFERENCES conversations(id),
  userId: text REFERENCES users(id),
  role: text ('user' | 'assistant'),
  content: text,  -- Plain text OR structured JSON with part ordering
  toolCalls: jsonb,
  toolResults: jsonb,
  createdAt: timestamp,
  isActive: boolean,  -- For soft delete and versioning
  agentRole: text,
  editedAt: timestamp
)
```

### Page AI Messages (`chat_messages` table)

```sql
chat_messages (
  id: text PRIMARY KEY,
  pageId: text REFERENCES pages(id),
  userId: text REFERENCES users(id),
  role: text,
  content: text,  -- Plain text OR structured JSON
  toolCalls: jsonb,
  toolResults: jsonb,
  createdAt: timestamp,
  isActive: boolean,
  agentRole: text,
  editedAt: timestamp
)
```

## The Critical Bug We Fixed

### The Problem

Before the fix, both AI endpoints were using messages from the client's request body instead of reading from the database:

```typescript
// ❌ WRONG: Uses client's stale messages
const { messages: requestMessages } = requestBody;
const sanitizedMessages = sanitizeMessagesForModel(requestMessages);
```

**This caused:**
1. User edits a message in the database
2. Client's Chat instance still has old version in memory
3. User sends new message
4. Client sends entire conversation history (stale) to API
5. API uses stale messages for AI context
6. AI processes old content, never seeing the edit ❌

### The Solution

Read ALL messages from the database at the start of every request:

```typescript
// ✅ CORRECT: Read from database (source of truth)
const dbMessages = await db
  .select()
  .from(messages)
  .where(and(
    eq(messages.conversationId, conversationId),
    eq(messages.isActive, true)
  ))
  .orderBy(messages.createdAt);

// Convert to UI format
const conversationHistory = dbMessages.map(msg =>
  convertGlobalAssistantMessageToUIMessage(msg)
);

// Use database messages for AI context
const sanitizedMessages = sanitizeMessagesForModel(conversationHistory);
```

## Implementation Guidelines

### Rule 1: Database is ALWAYS Source of Truth

```typescript
// ✅ CORRECT
const dbMessages = await db.select().from(messages).where(/* ... */);
const conversationHistory = dbMessages.map(convertToUIMessage);

// ❌ WRONG
const conversationHistory = requestBody.messages;
```

**Rationale:** The database is the single source of truth. Client state may be stale due to edits, multi-user updates, or synchronization delays.

### Rule 2: Client Sends ONLY New User Input

```typescript
// ✅ CORRECT
const newUserMessage = extractNewMessageFromRequest(requestBody);
await saveToDatabase(newUserMessage);

// ❌ WRONG
await saveToDatabase(requestBody.messages); // Bulk save entire conversation
```

**Rationale:** The client should only send the new user message. All previous messages should be read from the database.

### Rule 3: Message Loading Happens Server-Side

```typescript
// ✅ CORRECT Pattern
export async function POST(request: Request) {
  // 1. Load existing messages from database
  const dbMessages = await loadMessagesFromDatabase(conversationId);

  // 2. Extract new user message from request
  const newUserMessage = extractNewMessage(request);

  // 3. Save new user message immediately
  await saveMessageToDatabase(newUserMessage);

  // 4. Build conversation history from database
  const conversationHistory = [...dbMessages, newUserMessage];

  // 5. Stream AI response
  const result = await streamText({
    messages: convertToModelMessages(conversationHistory),
  });

  return result.toUIMessageStreamResponse();
}
```

**Rationale:** Server-side message loading ensures consistency and prevents stale data issues.

### Rule 4: Client Chat Instance is View-Only

```typescript
// Client-side: useChat is for UI rendering and streaming only
const { messages, sendMessage } = useChat({
  api: '/api/chat',
  // Messages in this hook are for UI display
  // They are NOT the source of truth
});
```

**Rationale:** The client Chat instance is a view layer. It may become stale and should not be trusted as the source of truth.

## Message Edit Flow

### Correct Flow (After Fix)

```
1. User edits message in database →
2. Database is updated ✅
3. User sends new message →
4. API reads ALL messages from database (fresh) ✅
5. API extracts only NEW user message from request ✅
6. AI processes with edited context ✅
7. Response based on correct context ✅
```

### Previous Incorrect Flow (Before Fix)

```
1. User edits message in database →
2. Database is updated ✅
3. Client Chat instance still has old version ❌
4. User sends new message →
5. Client sends entire conversation history (stale) ❌
6. API uses stale messages ❌
7. AI processes old context ❌
8. Response based on wrong context ❌
```

## Implementation Details

### Global AI Endpoint

**File:** `/app/api/ai_conversations/[id]/messages/route.ts`

**Key changes:**
- Lines 207-220: Extract request parameters (comment clarifies messages only for new input)
- Lines 327-366: Read all messages from database and convert to UI format
- Line 370: Use database-loaded messages for conversation history

### Page AI Endpoint

**File:** `/app/api/ai/chat/route.ts`

**Key changes:**
- Lines 100-114: Extract request parameters (comment clarifies messages only for new input)
- Lines 369-404: Read all messages from database and convert to UI format
- Line 408: Use database-loaded messages for conversation history

### Message Conversion Functions

**File:** `/lib/ai/assistant-utils.ts`

- `convertDbMessageToUIMessage()` - For Page AI messages
- `convertGlobalAssistantMessageToUIMessage()` - For Global AI messages

These functions handle:
- Structured content reconstruction
- Tool call and result restoration
- Part ordering preservation
- Edit timestamp tracking

## Common Pitfalls

### ❌ Pitfall 1: Using Client Messages

```typescript
// DON'T DO THIS
const { messages } = await request.json();
const result = await streamText({ messages });
```

**Problem:** Client messages may be stale after edits or multi-user updates.

### ❌ Pitfall 2: Not Reading from Database

```typescript
// DON'T DO THIS
const conversationHistory = requestBody.messages;
```

**Problem:** Bypasses the database, losing edits and multi-user changes.

### ❌ Pitfall 3: Bulk Saving Messages

```typescript
// DON'T DO THIS
for (const msg of requestBody.messages) {
  await saveToDatabase(msg);
}
```

**Problem:** Can overwrite database edits with stale client data.

## Benefits of Database-First Architecture

### 1. Multi-User Collaboration

Multiple users can:
- Edit the same conversation
- See each other's edits immediately
- Share AI context across team members
- Collaborate on AI-assisted tasks

### 2. Message Persistence and History

All messages are:
- Permanently stored in the database
- Searchable across conversations
- Queryable by date, user, content
- Available for analytics and reporting

### 3. Message Editability

Users can:
- Edit their messages after sending
- Regenerate AI responses with edited context
- Maintain conversation quality
- Correct mistakes without losing history

### 4. Permission-Based Access

AI conversations can:
- Enforce workspace permissions
- Filter context by user access level
- Prevent unauthorized data exposure
- Support enterprise security requirements

### 5. Audit Trail

Complete tracking of:
- All AI tool executions
- Message edits and versions
- User actions and timestamps
- Tool results and outputs

## Testing Checklist

When implementing or modifying AI endpoints, verify:

- [ ] Messages are read from database, not from client
- [ ] Only new user message is extracted from request
- [ ] Database is queried on every POST request
- [ ] Conversion functions properly reconstruct tool calls
- [ ] Edit timestamps are preserved
- [ ] Soft delete (isActive flag) is respected
- [ ] Multi-user scenarios work correctly
- [ ] Message edits are immediately visible to AI
- [ ] Tool calls and results are properly restored
- [ ] Performance is acceptable with large conversations

## Performance Considerations

### Database Query Optimization

```typescript
// Add indexes for common queries
CREATE INDEX idx_messages_conversation_active
ON messages(conversationId, isActive, createdAt);

CREATE INDEX idx_chat_messages_page_active
ON chat_messages(pageId, isActive, createdAt);
```

### Conversation Size Limits

Consider implementing:
- Cursor-based pagination for very long conversations
- Context window management (keep recent messages)
- Archival of old conversations
- Lazy loading of message history

### Caching Strategies

For high-traffic scenarios:
- Cache recent messages per conversation (with TTL)
- Invalidate cache on edits
- Use read replicas for message loading
- Implement connection pooling

## Migration from In-Memory Pattern

If you're migrating an existing AI SDK v5 implementation:

1. **Add database tables** for messages
2. **Update POST handlers** to read from database first
3. **Add message save logic** for user messages
4. **Update onFinish callbacks** to save AI responses
5. **Add conversion functions** for database ↔ UI format
6. **Test edit flows** to ensure database is source of truth
7. **Remove client-side bulk saves** to prevent staleness
8. **Add indexes** for query performance

## Conclusion

PageSpace's database-first AI architecture enables collaborative, persistent, and permission-aware AI conversations that standard AI SDK patterns cannot support. By treating the database as the single source of truth and reading conversation history from the database on every request, we ensure that message edits, multi-user changes, and workspace permissions are always respected.

The key principle: **The database is the source of truth, not the client's Chat instance.**

## Related Documentation

- [UI Refresh Protection](/docs/3.0-guides-and-tools/ui-refresh-protection.md)
- [Message Edit/Delete/Retry Implementation](/docs/2.0-architecture/ai-message-operations.md)
- [AI Tools Integration](/docs/2.0-architecture/ai-tools-system.md)
- [Permission System](/docs/2.0-architecture/permissions.md)
