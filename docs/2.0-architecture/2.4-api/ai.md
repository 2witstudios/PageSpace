# AI Chat Routes

## Overview

PageSpace's AI system implements a **database-first, message-as-row architecture** designed for multiplayer collaboration and persistent context. Unlike traditional chat applications that rely on client-side state or bulk message storage, our AI system treats each message as an individual database entity, enabling sophisticated features like cross-conversation mentions, permission-based access control, and real-time collaboration.

## Core Architecture Principles

### 1. Database-First Persistence
- **Individual Message Storage**: Each message (user or AI) is immediately saved as a separate database row
- **Single Source of Truth**: The database is the authoritative state for all conversations  
- **No Bulk Operations**: Messages are never saved in batches; each message is persisted as it's created
- **Direct Database Operations**: No abstraction layers - clean, type-safe database queries throughout

### 2. Page-Based Context Hierarchy
- **AI Pages are Pages**: AI conversations exist as `AI_CHAT` page types within the hierarchical page structure
- **Contextual Intelligence**: AI conversations inherit context from their position in the page tree
- **Permission Inheritance**: Access to AI conversations follows the same permission model as other page types

### 3. Multi-User Collaboration Ready
- **Real-Time Sync**: Multiple users can participate in the same AI conversation simultaneously
- **Consistent State**: All users see the same message history from the database
- **Message Attribution**: Each message is linked to its author (`userId` for humans, `null` for AI)

---

## API Routes

### POST /api/ai/chat

**Purpose:** Processes AI chat messages with immediate database persistence  
**Auth Required:** Yes  
**Request Schema:**
- `messages`: UIMessage[] (conversation history including new user message)
- `pageId`: string (page ID of the AI_CHAT page)
- `selectedProvider`: string (optional - 'openrouter' or 'google')
- `selectedModel`: string (optional - model identifier)
- `openRouterApiKey`: string (optional - API key for OpenRouter)
- `googleApiKey`: string (optional - API key for Google AI)

**Response:** Streaming UIMessage response with AI-generated content

**Persistence Flow:**
1. **User Message Saved Immediately**: The user's message is saved to `chat_messages` table upon receipt
2. **AI Processing**: Message is processed by selected AI provider without re-saving existing messages
3. **AI Response Saved**: The AI's response is saved to database when streaming completes

**Database Operations:**
```sql
-- User message (saved immediately)
INSERT INTO chat_messages (id, pageId, userId, role, content, createdAt, isActive)
VALUES (?, ?, ?, 'user', ?, NOW(), true);

-- AI response (saved on completion)
INSERT INTO chat_messages (id, pageId, userId, role, content, createdAt, isActive) 
VALUES (?, ?, NULL, 'assistant', ?, NOW(), true);
```

**Status Codes:** 200 (Streaming Response), 400 (Bad Request), 401 (Unauthorized), 500 (Internal Server Error)  
**Next.js 15 Handler:** async function with streaming response  
**Last Updated:** 2025-08-21

### GET /api/ai/chat

**Purpose:** Retrieves current AI provider configuration and settings  
**Auth Required:** Yes  
**Response Schema:**
- `currentProvider`: string (active AI provider)
- `currentModel`: string (active AI model)  
- `providers`: object (configuration status for each provider)
- `isAnyProviderConfigured`: boolean

**Status Codes:** 200 (OK), 401 (Unauthorized), 500 (Internal Server Error)  
**Last Updated:** 2025-08-21

### GET /api/ai/chat/messages

**Purpose:** Loads message history for an AI conversation  
**Auth Required:** Yes  
**Request Schema:**
- `pageId`: string (query parameter - AI_CHAT page ID)

**Response Schema:** Array of UIMessage objects with preserved timestamps  

**Implementation:**
```typescript
// Direct database query - no abstraction layers
const dbMessages = await db
  .select()
  .from(chatMessages)
  .where(and(
    eq(chatMessages.pageId, pageId),
    eq(chatMessages.isActive, true)
  ))
  .orderBy(chatMessages.createdAt);

// Convert to UIMessage format with preserved timestamps
const messages = dbMessages.map(msg => ({
  id: msg.id,
  role: msg.role as 'user' | 'assistant' | 'system',
  parts: [{ type: 'text', text: msg.content }],
  createdAt: msg.createdAt,
}));
```

**Status Codes:** 200 (OK), 400 (Bad Request), 401 (Unauthorized), 500 (Internal Server Error)  
**Last Updated:** 2025-08-21

---

## Database Schema

### chat_messages Table

```sql
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,           -- Message UUID
  pageId TEXT NOT NULL,          -- AI_CHAT page ID (FK to pages.id)
  userId TEXT,                   -- User ID (NULL for AI messages, FK to users.id)
  role TEXT NOT NULL,            -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,         -- Message text content
  toolCalls JSONB,              -- Tool/function calls (future use)
  toolResults JSONB,            -- Tool/function results (future use)
  createdAt TIMESTAMP NOT NULL,  -- Message creation time
  isActive BOOLEAN DEFAULT true, -- Soft delete flag for versioning
  editedAt TIMESTAMP             -- Last edit timestamp (future use)
);

-- Indexes for efficient queries
CREATE INDEX chat_messages_page_id_idx ON chat_messages(pageId);
CREATE INDEX chat_messages_user_id_idx ON chat_messages(userId);
CREATE INDEX chat_messages_page_id_is_active_created_at_idx 
  ON chat_messages(pageId, isActive, createdAt);
```

### Key Design Decisions

**Why `pageId` instead of `chatId`?**  
AI conversations are pages in the hierarchical system, allowing them to inherit context, permissions, and be nested within other pages.

**Why `isActive` boolean?**  
Supports future message versioning and editing capabilities without data loss. Messages can be "soft deleted" while preserving history.

**Why `userId` nullable?**  
AI messages have `userId = NULL`, while human messages have the user's ID, enabling clear attribution and permission checks.

---

## Supported AI Providers

### OpenRouter
- **Models**: Claude 3.5 Sonnet, GPT-4o, Llama 3.1 405B, etc.
- **Configuration**: API key stored encrypted per user
- **Features**: Multi-model support, cost tracking
- **SDK Version**: @openrouter/ai-sdk-provider ^1.1.2

### Google AI (Gemini)
- **Models**: Gemini 2.0 Flash, Gemini 1.5 Pro, Gemini 1.5 Flash
- **Configuration**: API key stored encrypted per user  
- **Features**: Fast inference, competitive pricing
- **SDK Version**: @ai-sdk/google ^2.0.6

### Ollama (Local)
- **Models**: Local model execution (llama3, codellama, etc.)
- **Configuration**: No API key required
- **Features**: Privacy-first, offline operation
- **SDK Version**: @ai-sdk/ollama ^1.2.0

### OpenAI
- **Models**: GPT-4, GPT-3.5-turbo, etc.
- **Configuration**: API key stored encrypted per user
- **Features**: Industry standard models
- **SDK Version**: @ai-sdk/openai ^1.3.23

### Anthropic
- **Models**: Claude models
- **Configuration**: API key stored encrypted per user
- **Features**: Advanced reasoning capabilities
- **SDK Version**: @ai-sdk/anthropic ^1.2.12

### xAI
- **Models**: Grok models
- **Configuration**: API key stored encrypted per user
- **Features**: Twitter/X integration
- **SDK Version**: @ai-sdk/xai (custom implementation)

---

## Global AI Conversations API

The Global AI Conversations system provides persistent, context-aware AI assistant functionality that exists outside the page hierarchy. Unlike page-based AI chats that are embedded within the workspace structure, global conversations offer users a dedicated AI assistant that can access context across their entire workspace.

### GET /api/ai_conversations

**Purpose:** Lists all AI conversations for the authenticated user.
**Auth Required:** Yes
**Request Schema:** None
**Response Schema:** Array of AI conversation objects:
- id: string
- title: string
- type: string ('global' | 'page' | 'drive')
- contextId: string | null
- lastMessageAt: timestamp
- createdAt: timestamp
**Implementation Notes:**
- Returns only active AI conversations (isActive = true)
- Ordered by lastMessageAt descending
- AI conversations are user ↔ assistant interactions
**Status Codes:** 200 (OK), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21

### POST /api/ai_conversations

**Purpose:** Creates a new AI conversation.
**Auth Required:** Yes
**Request Schema:**
- title: string (optional)
- type: string ('global' | 'page' | 'drive', default: 'global')
- contextId: string | null (page ID for page-specific conversations)
**Response Schema:** New AI conversation object.
**Status Codes:** 201 (Created), 400 (Bad Request), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21

### GET /api/ai_conversations/[id]

**Purpose:** Retrieves a specific AI conversation.
**Auth Required:** Yes
**Request Schema:**
- id: string (dynamic parameter - must await context.params in Next.js 15)
**Response Schema:** AI conversation object.
**Implementation Notes:**
- Uses Next.js 15 async params pattern
- Validates user owns the conversation
**Status Codes:** 200 (OK), 401 (Unauthorized), 404 (Not Found), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-08-21

### PATCH /api/ai_conversations/[id]

**Purpose:** Updates AI conversation metadata (e.g., title).
**Auth Required:** Yes
**Request Schema:**
- id: string (dynamic parameter - must await context.params in Next.js 15)
- title: string
**Response Schema:** Updated AI conversation object.
**Implementation Notes:**
- Uses Next.js 15 async params pattern
- Only allows title updates currently
**Status Codes:** 200 (OK), 401 (Unauthorized), 404 (Not Found), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-08-21

### DELETE /api/ai_conversations/[id]

**Purpose:** Soft deletes an AI conversation.
**Auth Required:** Yes
**Request Schema:**
- id: string (dynamic parameter - must await context.params in Next.js 15)
**Response Schema:** Success message.
**Implementation Notes:**
- Uses Next.js 15 async params pattern
- Sets isActive to false (soft delete)
**Status Codes:** 200 (OK), 401 (Unauthorized), 404 (Not Found), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-08-21

### GET /api/ai_conversations/[id]/messages

**Purpose:** Retrieves messages for a specific AI conversation.
**Auth Required:** Yes
**Request Schema:**
- id: string (dynamic parameter - must await context.params in Next.js 15)
- limit: number (query parameter - optional, default 50)
- offset: number (query parameter - optional, default 0)
**Response Schema:** Array of message objects with role ('user' | 'assistant').
**Implementation Notes:**
- Uses Next.js 15 async params pattern
- Supports pagination
- Messages are AI conversation history
**Status Codes:** 200 (OK), 401 (Unauthorized), 404 (Not Found), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-08-21

### POST /api/ai_conversations/[id]/messages

**Purpose:** Processes AI chat messages with streaming responses.
**Auth Required:** Yes
**Request Schema:**
- id: string (dynamic parameter - must await context.params in Next.js 15)
- messages: array of message objects
- agentRole: string (optional, agent behavior mode)
- locationContext: object (optional, current page/drive context)
- selectedProvider: string (AI provider)
- selectedModel: string (AI model)
**Response Schema:** Streaming AI response.
**Implementation Notes:**
- Uses Next.js 15 async params pattern
- Integrates with Vercel AI SDK for streaming
- Supports multiple AI providers (OpenRouter, Google AI, etc.)
- Messages saved to database in real-time
**Status Codes:** 200 (OK), 400 (Bad Request), 401 (Unauthorized), 404 (Not Found), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params and streaming response
**Last Updated:** 2025-08-21

### GET /api/ai_conversations/global

**Purpose:** Retrieves the most recent global AI conversation for the user.
**Auth Required:** Yes
**Request Schema:** None
**Response Schema:** Global AI conversation object or null.
**Implementation Notes:**
- Returns most recent global conversation by creation time
- Used for Global Assistant initialization
- Does not auto-create - returns null if none exists
**Status Codes:** 200 (OK), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21

---

## Additional AI Routes

### GET /api/ai/settings

**Purpose:** Returns current AI provider settings and configuration status for all providers  
**Auth Required:** Yes  
**Response Schema:**
- `currentProvider`: string (active AI provider from user settings)
- `currentModel`: string (active AI model from user settings)
- `providers`: object (configuration for each provider including PageSpace defaults)
- `pageSpaceSettings`: object (default PageSpace AI configuration)
- `openRouterSettings`: object (user's OpenRouter configuration)
- `googleSettings`: object (user's Google AI configuration)
- `openAISettings`: object (user's OpenAI configuration)
- `anthropicSettings`: object (user's Anthropic configuration)
- `xAISettings`: object (user's xAI configuration)

**Status Codes:** 200 (OK), 401 (Unauthorized), 500 (Internal Server Error)  
**Next.js 15 Handler:** async function returning Response/NextResponse  
**Last Updated:** 2025-08-21

### POST /api/ai/settings

**Purpose:** Updates AI provider settings for the authenticated user  
**Auth Required:** Yes  
**Request Schema:**
- `provider`: string ('openrouter' | 'google' | 'openai' | 'anthropic' | 'xai')
- `apiKey`: string (encrypted before storage)
- `model`: string (optional - preferred model for the provider)

**Response Schema:** Success message or error  
**Status Codes:** 200 (OK), 400 (Bad Request), 401 (Unauthorized), 500 (Internal Server Error)  
**Next.js 15 Handler:** async function returning Response/NextResponse  
**Last Updated:** 2025-08-21

### DELETE /api/ai/settings

**Purpose:** Removes AI provider settings for the authenticated user  
**Auth Required:** Yes  
**Request Schema:**
- `provider`: string ('openrouter' | 'google' | 'openai' | 'anthropic' | 'xai')

**Response Schema:** Success message  
**Status Codes:** 200 (OK), 400 (Bad Request), 401 (Unauthorized), 500 (Internal Server Error)  
**Next.js 15 Handler:** async function returning Response/NextResponse  
**Last Updated:** 2025-08-21

---

## Integration with PageSpace Features

### Mention System
AI conversations are discoverable through the mention system (`@ai-page`) because each message exists as a queryable database row:

```typescript
// AI conversations appear in mention searches
const aiPages = await db.select()
  .from(pages)
  .where(and(
    eq(pages.type, 'AI_CHAT'),
    ilike(pages.title, `%${query}%`)
  ));
```

### Permission Model
AI conversations inherit the same permission system as other pages:
- **EDIT permission**: Required to send messages to the AI
- **VIEW permission**: Required to read conversation history
- **Context inheritance**: AI can access parent page context based on user permissions

### Real-Time Collaboration
Multiple users can participate in AI conversations through:
- **Socket.IO integration**: Real-time message broadcasting
- **Database consistency**: All users see the same message state
- **Concurrent safety**: Database constraints prevent message conflicts

### Cross-Drive Search
AI conversations are searchable across drive boundaries because they exist in the unified page hierarchy with proper permission filtering.

---

## Why This Architecture?

### Traditional AI SDK Approach (What We Don't Do)
```typescript
// ❌ Complex abstraction layers
const adapter = createChatStorageAdapter();
await adapter.saveMessages(chatId, messages); // 240+ lines of complexity

// ❌ Bulk save entire conversation on each interaction
onFinish: ({ messages }) => {
  await saveChat({ chatId, messages }); // Overwrites entire history
}
```

### PageSpace Database-First Approach (What We Do)
```typescript
// ✅ Direct, clean database operations
await db.insert(chatMessages).values({
  id: messageId,
  pageId: chatId,
  userId,
  role: 'user',
  content: messageContent,
  createdAt: new Date(),
  isActive: true,
});

// ✅ Simple, type-safe queries
const messages = await db
  .select()
  .from(chatMessages)
  .where(and(
    eq(chatMessages.pageId, pageId),
    eq(chatMessages.isActive, true)
  ))
  .orderBy(chatMessages.createdAt);
```

### Benefits of Our Approach

1. **No Message Duplication**: Each message saved exactly once
2. **Real-Time Collaboration**: Multiple users share consistent state
3. **Advanced Features**: Mentions, permissions, search all work seamlessly
4. **Message Versioning**: `isActive` flag supports editing/regeneration
5. **Audit Trails**: Complete history of who said what and when
6. **Context Inheritance**: AI conversations understand their place in the page hierarchy
7. **Permission Integration**: Access control works consistently with the rest of the system

This architecture enables PageSpace's AI system to be a first-class citizen in the collaborative, hierarchical workspace rather than an isolated chat feature.