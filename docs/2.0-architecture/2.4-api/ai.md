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

**Purpose:** Processes AI chat messages with advanced tool calling and immediate database persistence
**Auth Required:** Yes
**Request Schema:**
- `messages`: UIMessage[] (conversation history including new user message)
- `chatId`: string (page ID of the AI_CHAT page)
- `selectedProvider`: string (optional - 'openrouter', 'google', 'openai', 'anthropic', 'xai', 'ollama')
- `selectedModel`: string (optional - model identifier)
- `openRouterApiKey`: string (optional - API key for OpenRouter)
- `googleApiKey`: string (optional - API key for Google AI)
- `openAIApiKey`: string (optional - API key for OpenAI)
- `anthropicApiKey`: string (optional - API key for Anthropic)
- `xaiApiKey`: string (optional - API key for xAI)
- `ollamaBaseUrl`: string (optional - Ollama instance URL)
- `pageContext`: object (optional - current page context for tool execution)

**Enhanced Features:**
- **Advanced Tool Calling**: 13+ workspace automation tools across 6 categories
- **Model Capability Detection**: Automatic vision and tool support detection
- **Permission-Based Tool Filtering**: Tools filtered by agent role and custom configurations
- **Multi-Step Operations**: Support for up to 100 tool calls per conversation
- **Agent Communication**: AI agents can consult other specialized agents
- **Real-Time Broadcasting**: Tool execution results broadcast to all connected users

**Tool Categories Available:**
1. **Core Page Operations** (6 tools): list_drives, list_pages, read_page, create_page, move_page, list_trash
2. **Content Editing Tools** (1 tool): replace_lines
3. **Trash Operations** (2 tools): trash, restore (unified for pages and drives)
4. **Advanced Search & Discovery** (3 tools): regex_search, glob_search, multi_drive_search
5. **Task Management** (1 tool): update_task (works with TASK_LIST pages created via create_page)
6. **Agent Management** (4 tools): list_agents, ask_agent, update_agent_config, multi_drive_list_agents

**Tool Execution Flow:**
1. **Capability Detection**: Model capabilities (vision, tools) automatically detected
2. **Tool Filtering**: Tools filtered based on agent role and enabled tools configuration
3. **Permission Validation**: Each tool execution validates user permissions
4. **Multi-Step Processing**: Complex operations can chain multiple tool calls
5. **Result Broadcasting**: Tool execution results broadcast to all conversation participants

**Enhanced Database Operations:**
```sql
-- User message with mention processing
INSERT INTO chat_messages (id, pageId, userId, role, content, toolCalls, toolResults, createdAt, isActive)
VALUES (?, ?, ?, 'user', ?, NULL, NULL, NOW(), true);

-- AI response with tool calls and results
INSERT INTO chat_messages (id, pageId, userId, role, content, toolCalls, toolResults, createdAt, isActive)
VALUES (?, ?, NULL, 'assistant', ?, ?, ?, NOW(), true);
```

**Tool Call Storage:**
```typescript
// Tool calls stored as JSON in database
toolCalls: [
  {
    toolCallId: "call_123",
    toolName: "create_page",
    args: { driveId: "drive-456", title: "New Document", type: "DOCUMENT" }
  }
]

// Tool results stored as JSON
toolResults: [
  {
    toolCallId: "call_123",
    result: { success: true, pageId: "page-789", title: "New Document" }
  }
]
```

**Enhanced AI Processing:**
```typescript
// Advanced streamText configuration
const result = streamText({
  model,
  system: systemPrompt + mentionSystemPrompt + timestampSystemPrompt,
  messages: convertToModelMessages(sanitizedMessages),
  tools: filteredTools,  // Permission-based tool filtering
  stopWhen: stepCountIs(100), // Allow complex multi-step operations
  experimental_context: {
    userId,
    modelCapabilities: getModelCapabilities(currentModel, currentProvider),
    locationContext: pageContext
  },
  maxRetries: 20 // Enhanced retry for rate limits
});
```

**Response:** Streaming UIMessage response with AI-generated content and tool execution results

**Status Codes:** 200 (Streaming Response), 400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with streaming response and tool execution
**Last Updated:** 2025-01-21

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

> **Note:** These routes were reorganized in November 2025 from `/api/ai_conversations` to `/api/ai/global` for semantic clarity.

### GET /api/ai/global

**Purpose:** Lists all global AI conversations for the authenticated user.
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
**Last Updated:** 2025-11-28

### POST /api/ai/global

**Purpose:** Creates a new global AI conversation.
**Auth Required:** Yes
**Request Schema:**
- title: string (optional)
- type: string ('global' | 'page' | 'drive', default: 'global')
- contextId: string | null (page ID for page-specific conversations)
**Response Schema:** New AI conversation object.
**Status Codes:** 201 (Created), 400 (Bad Request), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-11-28

### GET /api/ai/global/[id]

**Purpose:** Retrieves a specific global AI conversation.
**Auth Required:** Yes
**Request Schema:**
- id: string (dynamic parameter - must await context.params in Next.js 15)
**Response Schema:** AI conversation object.
**Implementation Notes:**
- Uses Next.js 15 async params pattern
- Validates user owns the conversation
**Status Codes:** 200 (OK), 401 (Unauthorized), 404 (Not Found), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-11-28

### PATCH /api/ai/global/[id]

**Purpose:** Updates global AI conversation metadata (e.g., title).
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
**Last Updated:** 2025-11-28

### DELETE /api/ai/global/[id]

**Purpose:** Soft deletes a global AI conversation.
**Auth Required:** Yes
**Request Schema:**
- id: string (dynamic parameter - must await context.params in Next.js 15)
**Response Schema:** Success message.
**Implementation Notes:**
- Uses Next.js 15 async params pattern
- Sets isActive to false (soft delete)
**Status Codes:** 200 (OK), 401 (Unauthorized), 404 (Not Found), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-11-28

### GET /api/ai/global/[id]/messages

**Purpose:** Retrieves messages for a specific global AI conversation.
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
**Last Updated:** 2025-11-28

### POST /api/ai/global/[id]/messages

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
**Last Updated:** 2025-11-28

### DELETE /api/ai/global/[id]/messages/[messageId]

**Purpose:** Deletes a specific message from a global AI conversation.
**Auth Required:** Yes
**Request Schema:**
- id: string (conversation ID - must await context.params in Next.js 15)
- messageId: string (message ID - must await context.params in Next.js 15)
**Response Schema:** Success message.
**Implementation Notes:**
- Uses Next.js 15 async params pattern
- Validates user owns the conversation
**Status Codes:** 200 (OK), 401 (Unauthorized), 404 (Not Found), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-11-28

### GET /api/ai/global/[id]/usage

**Purpose:** Gets AI usage statistics for a specific global conversation.
**Auth Required:** Yes
**Request Schema:**
- id: string (dynamic parameter - must await context.params in Next.js 15)
**Response Schema:** Usage statistics object with token counts and costs.
**Status Codes:** 200 (OK), 401 (Unauthorized), 404 (Not Found), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-11-28

### GET /api/ai/global/active

**Purpose:** Retrieves the most recent active global AI conversation for the user.
**Auth Required:** Yes
**Request Schema:** None
**Response Schema:** Global AI conversation object or null.
**Implementation Notes:**
- Returns most recent global conversation by creation time
- Used for Global Assistant initialization
- Does not auto-create - returns null if none exists
**Status Codes:** 200 (OK), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-11-28

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

### Enhanced Permission Model
AI conversations inherit the same permission system as other pages with additional tool-specific validations:

- **EDIT permission**: Required to send messages to the AI
- **VIEW permission**: Required to read conversation history
- **Tool execution permissions**: Each tool validates user permissions for the target operation
- **Context inheritance**: AI can access parent page context based on user permissions
- **Agent consultation permissions**: `ask_agent` tool validates access to target agents

```typescript
// Tool permission validation example
const accessLevel = await getUserAccessLevel(userId, pageId);
if (!canUserEditPage(userId, pageId)) {
  throw new Error('Insufficient permissions for this operation');
}

// Agent communication permission check
const canViewAgent = await canUserViewPage(userId, agentId);
if (!canViewAgent) {
  throw new Error('Insufficient permissions to consult agent');
}
```

### Enhanced Real-Time Collaboration
Multiple users can participate in AI conversations with advanced real-time features:

- **Socket.IO integration**: Real-time message and tool execution broadcasting
- **Database consistency**: All users see the same message state
- **Concurrent safety**: Database constraints prevent message conflicts
- **Tool execution broadcasting**: Tool results broadcast to all conversation participants
- **Agent communication updates**: Cross-agent consultations visible to all users

```typescript
// Enhanced real-time broadcasting for tool execution
await broadcastPageEvent({
  type: 'tool_executed',
  pageId: chatId,
  userId,
  metadata: {
    toolName: 'create_page',
    result: toolResult,
    timestamp: new Date()
  }
});

// Agent communication broadcasting
await broadcastAgentEvent({
  type: 'agent_consultation',
  sourceAgentId: currentAgentId,
  targetAgentId: consultedAgentId,
  question: question,
  response: agentResponse
});
```

### Advanced Cross-Drive Search
AI conversations and tool execution results are searchable across drive boundaries with enhanced capabilities:

- **Cross-conversation search**: Find information across all AI interactions
- **Tool execution history**: Search through tool calls and results
- **Agent consultation logs**: Discover past agent-to-agent communications
- **Permission filtering**: All searches respect user access controls

```typescript
// Enhanced search across AI conversations with tool context
const searchResults = await multi_drive_search({
  query: "project status",
  searchType: "both", // content and tool results
  includeToolResults: true,
  includeAgentConsultations: true
});

// Search tool execution history
const toolHistory = await searchToolExecutions({
  toolName: "create_page",
  userId: userId,
  dateRange: { start: "2024-01-01", end: "2024-01-31" }
});
```

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

### Enhanced Benefits of Our Tool-Integrated Approach

1. **No Message Duplication**: Each message saved exactly once with complete tool context
2. **Real-Time Collaboration**: Multiple users share consistent state with tool execution visibility
3. **Advanced Workspace Automation**: 13+ tools enable sophisticated multi-step operations
4. **Tool Execution Audit Trails**: Complete history of AI-driven workspace changes
5. **Permission-Aware Automation**: All tool operations respect user access controls
6. **Agent Collaboration**: AI agents can consult each other for specialized expertise
7. **Model Capability Adaptation**: Automatic detection and graceful degradation
8. **Context Inheritance**: AI conversations understand their place in the page hierarchy
9. **Persistent Task Management**: Cross-session task continuity and progress tracking
10. **Batch Operation Support**: Atomic multi-page operations for efficiency
11. **Advanced Search Integration**: AI can discover and analyze content across the workspace
12. **Custom Agent Configuration**: Per-page tool permissions and specialized behaviors

### Tool-Enhanced Architecture Benefits

**Traditional AI Chat:**
```
User → AI → Text Response
```

**PageSpace Tool-Enhanced AI:**
```
User → AI → Tool Execution → Workspace Changes → Contextual Response
        ↓
   Permission Validation
   Real-time Broadcasting
   Audit Trail Logging
   Cross-Agent Communication
   Task Management Integration
```

This architecture transforms AI from a simple chat interface into a powerful workspace automation system that can handle complex, multi-step operations while maintaining data consistency, security, and collaborative features. AI becomes a true workspace citizen capable of reading, creating, organizing, and managing content across the entire PageSpace ecosystem.

For detailed information about specific tools and their usage, see:
- [AI Tool Calling Architecture](../2.6-features/ai-tool-calling.md)
- [AI Tools Reference Guide](../../../3.0-guides-and-tools/ai-tools-reference.md)
- [Model Capabilities Detection](../2.6-features/model-capabilities.md)