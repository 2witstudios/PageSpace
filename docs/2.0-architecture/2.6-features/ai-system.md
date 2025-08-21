# AI System Architecture

## Philosophy: AI as Contextual Intelligence

PageSpace treats AI not as an isolated chatbot, but as **contextual intelligence embedded within the workspace hierarchy**. AI conversations exist as pages, inherit context from their location, and participate in the same collaborative, permission-based ecosystem as documents, folders, and other content types.

---

## Core Architectural Principles

### 1. Pages as AI Containers

AI conversations are `AI_CHAT` page types, making them first-class citizens in the PageSpace ecosystem:

```
📁 Project Alpha/
├── 📄 Requirements.md
├── 📁 Research/
│   ├── 🤖 AI Research Assistant    ← AI_CHAT page
│   └── 📄 Market Analysis.md
└── 🤖 Project Planning AI          ← AI_CHAT page
```

**Implications:**
- AI conversations inherit permissions from parent pages
- AI can reference and understand sibling documents  
- AI conversations appear in search, mentions, and navigation
- Multiple AI contexts can exist at different hierarchy levels

### 2. Database-First Message Persistence

Unlike traditional AI SDKs that manage state client-side or in bulk, PageSpace implements **message-as-row architecture**:

```sql
-- Actual chat_messages schema (packages/db/src/schema/core.ts)
chat_messages table:
[id] [pageId] [userId] [role] [content] [toolCalls] [toolResults] [createdAt] [isActive] [editedAt] [agentRole]
msg1  page123   user1   user   "Help me..."  NULL         NULL         2024-01-01  true     NULL      PARTNER
msg2  page123   NULL    assistant "I can help!" [tools...]   [results...] 2024-01-01  true     NULL      PARTNER  
msg3  page123   user2   user   "Also, can..."  NULL         NULL         2024-01-01  true     NULL      PARTNER
msg4  page123   NULL    assistant "Yes, also..." [tools...]   [results...] 2024-01-01  true     NULL      PARTNER
```

**Benefits:**
- **Multi-user collaboration**: Multiple people can chat with the same AI
- **Real-time sync**: All participants see messages as they arrive
- **Message attribution**: Clear record of who said what
- **AI Tool Integration**: Tool calls and results stored for context and debugging
- **Agent Role Tracking**: Different AI personalities (PARTNER, ASSISTANT, etc.)
- **Cross-conversation search**: Find information across all AI interactions
- **Permission enforcement**: Only authorized users see conversation history
- **Message versioning**: Support for editing and regeneration via isActive flag

### 3. Contextual Intelligence Hierarchy

AI conversations understand their position in the workspace hierarchy and can access contextually relevant information:

```
📁 Marketing Campaign/
├── 📄 Brand Guidelines.md
├── 📄 Target Audience.md  
└── 🤖 Campaign AI          ← Can reference Brand Guidelines and Target Audience
```

**Context Flow:**
- **Upward Context**: AI can reference parent and sibling pages (with permission)
- **Hierarchical Awareness**: AI understands its role within the project structure
- **Permission Boundaries**: AI context is limited by user's access permissions

---

## Multi-User Collaboration Model

### Shared AI Conversations

Multiple users can participate in the same AI conversation simultaneously:

```typescript
// User A sends message → Saved to database
const messageA = {
  pageId: 'ai-page-123',
  userId: 'user-a',
  role: 'user',
  content: 'Can you analyze our sales data?'
};

// User B sees User A's message in real-time
// AI responds → Response visible to both users  
const aiResponse = {
  pageId: 'ai-page-123', 
  userId: null,
  role: 'assistant',
  content: 'I'll analyze the sales data from Q3...'
};

// User B can continue conversation
const messageB = {
  pageId: 'ai-page-123',
  userId: 'user-b', 
  role: 'user',
  content: 'Also look at customer segments'
};
```

### Permission-Based AI Access

AI conversations respect the same permission system as other pages:

- **VIEW Permission**: Can read conversation history
- **EDIT Permission**: Can send messages to AI
- **Context Access**: AI can only reference pages the user has permission to view

```typescript
// AI context is filtered by user permissions
const contextPages = await getAccessiblePages(userId, parentPageId);
const aiContext = `You have access to: ${contextPages.map(p => p.title).join(', ')}`;
```

---

## Nested AI Contexts

PageSpace supports AI conversations at multiple levels of the hierarchy, each with appropriate context:

### Project-Level AI
```
📁 Website Redesign/
└── 🤖 Project AI          ← Knows about entire project
    Context: All project documents, team members, timelines
```

### Feature-Level AI  
```
📁 Website Redesign/
├── 📁 User Interface/
│   └── 🤖 UI Design AI    ← Focused on UI concerns
│       Context: Design files, user research, UI guidelines
```

### Document-Level AI
```
📁 Website Redesign/  
├── 📁 User Interface/
│   ├── 📄 Wireframes.md
│   └── 🤖 Wireframe Review AI  ← Specific to wireframe feedback
│       Context: Just the wireframes document
```

### Benefits of Nested Contexts

1. **Focused Intelligence**: Each AI has appropriate scope for its role
2. **Reduced Noise**: AI doesn't get overwhelmed with irrelevant context
3. **Specialized Expertise**: Different AIs can have different personalities/capabilities
4. **Permission Isolation**: Sensitive information stays within appropriate boundaries

---

## AI Provider Architecture

### Multi-Provider Support

PageSpace supports multiple AI providers with unified interface via Vercel AI SDK:

```typescript
// Actual supported providers (from ai-providers-config.ts):
const providers = {
  pagespace: new OpenRouterProvider(),    // Default with app's OpenRouter key
  openrouter: new OpenRouterProvider(),   // User's OpenRouter key
  openrouter_free: new OpenRouterProvider(), // Free models via OpenRouter
  google: new GoogleAIProvider(),         // @ai-sdk/google
  openai: new OpenAIProvider(),           // @ai-sdk/openai  
  anthropic: new AnthropicProvider(),     // @ai-sdk/anthropic
  xai: new XAIProvider(),                 // @ai-sdk/xai (Grok models)
};

// 100+ models across all providers including:
// - Claude 4.1, GPT-5, Gemini 2.5 Pro, Grok 4
// - Free models: Qwen3, DeepSeek R1, Mistral Small
```

### User-Specific Configuration

AI settings are stored per provider with encryption:

```sql
-- Actual schema (packages/db/src/schema/ai.ts)
CREATE TABLE user_ai_settings (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,        -- 'pagespace' | 'openrouter' | 'google' | 'openai' | 'anthropic' | 'xai'
  encryptedApiKey TEXT,         -- Encrypted API key
  baseUrl TEXT,                 -- Custom base URL if needed
  createdAt TIMESTAMP,
  updatedAt TIMESTAMP,
  UNIQUE(userId, provider)      -- One setting per provider per user
);

-- Page-specific AI settings (in core.ts)
ALTER TABLE pages ADD COLUMN aiProvider TEXT;
ALTER TABLE pages ADD COLUMN aiModel TEXT;
```

---

## Integration with PageSpace Features

### Mention System (@ai Integration)

AI conversations participate in the mention system:

```typescript
// Users can mention AI conversations
@ai-project-assistant "What's the status of the redesign?"

// AI conversations appear in mention search
const aiPages = await searchPages({
  type: 'AI_CHAT',
  query: 'project',
  permissions: userPermissions
});
```

### Real-Time Collaboration (Socket.IO)

AI messages are broadcast to all conversation participants:

```typescript
// When AI responds, notify all users in the conversation
socket.to(`page:${pageId}`).emit('new_message', {
  id: messageId,
  role: 'assistant', 
  content: aiResponse,
  createdAt: new Date()
});
```

### Cross-Drive Search

AI conversations are searchable across the entire workspace:

```typescript
// Find AI conversations about "marketing" across all accessible drives
const results = await searchAIConversations({
  query: 'marketing',
  userId,
  crossDrive: true
});
```

### AI Tools Integration

PageSpace AI has access to powerful workspace tools for reading, creating, and modifying content:

```typescript
// Available tools (from ai-tools.ts):
const pageSpaceTools = {
  list_drives,           // List all accessible workspaces
  list_pages,            // Explore page hierarchies  
  read_page,             // Read document content
  create_page,           // Create new pages (any type)
  rename_page,           // Rename existing pages
  replace_lines,         // Edit specific document lines
  insert_lines,          // Insert content at specific positions
  append_to_page,        // Add content to end of page
  prepend_to_page,       // Add content to beginning of page
  trash_page,            // Delete individual pages
  trash_page_with_children, // Delete page and all children
  restore_page,          // Restore from trash
  move_page,             // Move/reorder pages
  list_trash,            // View trashed items
};

// Tool execution with permission filtering
const roleFilteredTools = ToolPermissionFilter.filterTools(pageSpaceTools, agentRole);
```

### Agent Role System

Three distinct AI personalities with different permissions and behaviors:

```typescript
// Agent roles (from agent-roles.ts):
enum AgentRole {
  PARTNER = 'PARTNER',   // Collaborative AI partner with balanced capabilities
  PLANNER = 'PLANNER',   // Strategic planning assistant (read-only)
  WRITER = 'WRITER'      // Execution-focused assistant with minimal conversation
}

// Role permissions and capabilities:
const ROLE_PERMISSIONS = {
  PARTNER: {
    canRead: true, canWrite: true, canDelete: true,
    allowedOperations: ['read', 'write', 'create', 'update', 'delete', 'organize'],
    description: 'Collaborative AI partner with balanced capabilities'
  },
  PLANNER: {
    canRead: true, canWrite: false, canDelete: false,
    allowedOperations: ['read', 'analyze', 'plan', 'explore'],
    description: 'Strategic planning assistant (read-only)'
  },
  WRITER: {
    canRead: true, canWrite: true, canDelete: true,
    allowedOperations: ['read', 'write', 'create', 'update', 'delete', 'execute'],
    description: 'Execution-focused assistant with minimal conversation'
  }
};

// Role-based tool filtering and prompts
const systemPrompt = RolePromptBuilder.buildSystemPrompt(agentRole, 'page', pageContext);
```

### Message Versioning

The `isActive` boolean enables message editing and regeneration:

```sql
-- Original message
INSERT INTO chat_messages (id, pageId, content, isActive) 
VALUES ('msg1', 'page1', 'First response', true);

-- Regenerated message (original marked inactive)
UPDATE chat_messages SET isActive = false WHERE id = 'msg1';
INSERT INTO chat_messages (id, pageId, content, isActive, editedAt)
VALUES ('msg1-v2', 'page1', 'Better response', true, NOW());
```

---

## Why This Architecture Matters

### For Single Users
- **Contextual AI**: AI understands your project structure
- **Persistent Memory**: Conversations saved permanently  
- **Multi-Context**: Different AIs for different purposes

### For Teams
- **Shared Intelligence**: Team can collaborate with AI together
- **Knowledge Continuity**: AI conversations become team knowledge
- **Permission Safety**: AI respects team access controls

### For Organizations  
- **Audit Trails**: Complete record of AI interactions
- **Context Control**: AI knowledge scoped appropriately
- **Integration Ready**: AI participates in existing workflows

---

## Implementation Benefits

### Compared to Traditional AI Chatbots

**Traditional Approach:**
```
User → AI Service → Response
       ↓
   Session Storage (temporary)
```

**PageSpace Approach:**
```
User → Database → AI Service → Database
       ↓                      ↓
   Persistent Messages    Collaborative State
   Permission Enforced    Context Aware
   Searchable History     Multi-User Ready
```

### Why Database-First Wins

1. **Collaboration**: Multiple users can share AI conversations
2. **Persistence**: Messages never lost, always searchable  
3. **Context**: AI understands workspace hierarchy
4. **Permissions**: AI respects access controls
5. **Integration**: AI participates in mentions, search, navigation
6. **Versioning**: Support for message editing/regeneration
7. **Audit**: Complete trail of AI interactions
8. **Performance**: Direct database operations, no abstraction overhead
9. **Maintainability**: Simple, readable code with clear data flow
10. **Type Safety**: Full TypeScript support with database schema validation
11. **AI Tool Integration**: Native workspace automation and content manipulation
12. **Role-Based Access**: Granular control over AI capabilities per conversation
13. **Advanced Monitoring**: Comprehensive usage tracking and cost analysis

## Implementation Principles

### Production-Ready Simplicity

PageSpace's AI system prioritizes **clear, direct code** over complex abstractions:

```typescript
// ✅ Simple message loading with tool support
const messages = await db
  .select()
  .from(chatMessages)
  .where(and(
    eq(chatMessages.pageId, pageId),
    eq(chatMessages.isActive, true)
  ))
  .orderBy(chatMessages.createdAt);

// ✅ Direct message saving with AI enhancements
await db.insert(chatMessages).values({
  id: messageId,
  pageId: chatId,
  userId,
  role: 'user',
  content: messageContent,
  toolCalls: null,           // JSON storage for tool execution
  toolResults: null,         // JSON storage for tool results
  createdAt: new Date(),
  isActive: true,
  agentRole: 'PARTNER',     // Track AI personality
});
```

### No Abstraction Layers

Unlike traditional AI SDKs that introduce complex storage adapters and bulk operations, PageSpace uses:

- **Direct database queries**: Type-safe, readable, debuggable
- **Individual message operations**: Each message saved/loaded independently  
- **Clear data flow**: Database → API → Frontend, no hidden transformations
- **Production logging**: Minimal, purposeful console output

### Optimized for Team Collaboration

Every architectural decision supports multiple users working together:

- **Real-time sync**: Database as single source of truth
- **Permission integration**: Direct queries work with existing auth system
- **Cross-conversation search**: Messages are queryable database entities
- **Audit trails**: Complete history of all AI interactions

This architecture makes AI a collaborative workspace citizen rather than an isolated tool, enabling the sophisticated multiplayer AI experiences that PageSpace is built for.

---

## Current Implementation Status

### ✅ Fully Implemented
- **Multi-provider support**: PageSpace, OpenRouter, Google, OpenAI, Anthropic, xAI
- **100+ AI models**: From free Qwen/DeepSeek to premium Claude 4.1/GPT-5
- **Database-first persistence**: Messages stored immediately in PostgreSQL
- **AI tool integration**: 13 workspace tools for content manipulation
- **Agent role system**: PARTNER, PLANNER, and WRITER personalities with distinct capabilities
- **Permission-based access**: Full integration with PageSpace's auth system
- **Real-time collaboration**: Socket.IO for live message sync
- **Page-specific settings**: Per-page AI provider/model configuration
- **Advanced monitoring**: Usage tracking, cost analysis, token counting

### 🔄 In Development
- **Message editing/regeneration**: Schema supports it, UI implementation pending
- **Enhanced tool permissions**: More granular role-based tool access
- **Conversation templates**: Pre-configured AI contexts for common workflows

### 📋 Planned
- **Ollama integration**: Local model support (infrastructure exists)
- **Custom agent roles**: User-defined AI personalities beyond PARTNER/PLANNER/WRITER
- **AI workflow automation**: Scheduled AI tasks and content generation