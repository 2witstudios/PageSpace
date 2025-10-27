# Agent Conversation Architecture: Bug Fixes & New Design

**Date**: 2025-10-26
**Status**: Planning
**Related Files**:
- `apps/web/src/components/layout/middle-content/page-views/ai-page/AiChatView.tsx`
- `apps/web/src/lib/ai/tools/agent-communication-tools.ts`
- `packages/db/src/schema/core.ts`

---

## Problems Identified

### Bug 1: Agent Message History Not Displaying on Page Load

**Symptoms**:
- When you open an AI_CHAT page directly, the conversation history doesn't display
- Messages exist in the database and ARE being fetched from the API
- On page refresh, all messages disappear even though they're persisted

**Root Cause**:
The `AiChatView` component has a timing/initialization bug in how it loads messages into the AI SDK's `useChat` hook:

1. Component mounts with `isInitialized = false` and `initialMessages = []`
2. `useChat` hook initializes with `chatConfig` containing `messages: []` (empty array)
3. The `chatConfig` useMemo has `page.id` as dependency but **excludes `initialMessages`** (line 117)
4. The `initializeChat()` async function loads messages from API
5. `setInitialMessages(existingMessages)` updates state
6. `setIsInitialized(true)` is called
7. **BUT** the `chatConfig` never re-runs because `initialMessages` is not in its dependency array
8. So `useChat` hook was already initialized with empty messages and never receives the loaded ones

**Evidence**:
```typescript
// Line 117 in AiChatView.tsx
}), [page.id]); // initialMessages intentionally excluded - passed once for AI SDK v5 pattern

// Lines 280-282 - Messages ARE loaded but not synced
if (messagesResponse.ok) {
  const existingMessages: UIMessage[] = await messagesResponse.json();
  setInitialMessages(existingMessages); // ← State updated
  // Missing: setMessages(existingMessages) ← AI SDK never receives them
}
```

**Current Behavior**: Empty chat on every page load/refresh
**Expected Behavior**: Display all historical messages from the database

---

### Bug 2: ask_agent is Not Truly Independent

**Symptoms**:
- `ask_agent` tool retains conversation memory across calls
- When global assistant calls `ask_agent`, the target agent sees its previous conversation history
- This creates confusion about whether consultations are stateless or stateful

**Root Cause**:
The `ask_agent` tool implementation loads the target agent's conversation history:

```typescript
// Lines 429-437 in agent-communication-tools.ts
const agentHistory = await db.select()
  .from(chatMessages)
  .where(and(
    eq(chatMessages.pageId, agentId),
    eq(chatMessages.isActive, true)
  ))
  .orderBy(asc(chatMessages.createdAt))
  .limit(MAX_CONVERSATION_WINDOW); // 50 messages

const historyMessages = agentHistory.map(convertDbMessageToUIMessage);

// Lines 442-455 - History is included in the message chain
const messages: UIMessage[] = [
  ...historyMessages,  // ← Target agent's conversation history
  userMessage
];
```

**Current Behavior**: Each `ask_agent` call includes up to 50 messages of conversation history
**Expected Behavior**: Each `ask_agent` call should be independent, stateless, with no conversation memory

**Trade-off**: Making this stateless means the target agent won't have context from previous consultations. The global assistant can work around this by providing more context in the question parameter.

---

## Proposed Architecture

### Overview

Transform the agent conversation system into a **ChatGPT-style interface** with:

1. **Conversation Sessions**: Multiple distinct conversations per agent (not one continuous thread)
2. **History Tab**: Browse and select previous conversations
3. **Chat Tab**: Display currently active conversation
4. **Stateless ask_agent**: Independent consultations with no memory
5. **Cross-Agent Search**: Global assistant can search all agent conversations

---

### Architecture Components

#### 1. Database Schema Changes

**Add conversation session tracking to `chatMessages` table**:

```typescript
// packages/db/src/schema/core.ts

export const chatMessages = pgTable('chat_messages', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  pageId: text('pageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  conversationId: varchar('conversation_id', { length: 255 }).notNull(), // ← NEW FIELD
  role: text('role').notNull(),
  content: text('content').notNull(),
  toolCalls: jsonb('toolCalls'),
  toolResults: jsonb('toolResults'),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  isActive: boolean('isActive').default(true).notNull(),
  editedAt: timestamp('editedAt', { mode: 'date' }),
  userId: text('userId').references(() => users.id, { onDelete: 'cascade' }),
  agentRole: text('agentRole').default('PARTNER').notNull(),
  messageType: text('messageType', { enum: ['standard', 'todo_list'] }).default('standard').notNull(),
}, (table) => {
  return {
    pageIdx: index('chat_messages_page_id_idx').on(table.pageId),
    userIdx: index('chat_messages_user_id_idx').on(table.userId),
    conversationIdx: index('chat_messages_conversation_id_idx').on(table.conversationId), // ← NEW INDEX
    pageIsActiveCreatedAtIndex: index('chat_messages_page_id_is_active_created_at_idx').on(table.pageId, table.isActive, table.createdAt),
  }
});
```

**Migration Strategy**:
- All existing messages get a generated `conversationId` (e.g., UUID or timestamp-based)
- Group existing messages by `pageId` into a single initial conversation per agent
- Default value for new messages: Generate new UUID for each new conversation

**Optional: Add conversations metadata table** (for storing conversation titles, metadata):

```typescript
export const agentConversations = pgTable('agent_conversations', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  pageId: text('pageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  title: text('title'), // Optional custom title, defaults to auto-generated from first message
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull(),
});
```

---

#### 2. API Endpoints

**New REST endpoints for conversation management**:

##### GET `/api/agents/[agentId]/conversations`
Lists all conversations for a specific agent.

**Response**:
```typescript
{
  conversations: [
    {
      id: string,
      title: string,           // Auto-generated or custom
      createdAt: Date,
      updatedAt: Date,
      messageCount: number,
      preview: string,         // First user message (truncated)
      lastMessage: {
        role: 'user' | 'assistant',
        preview: string,
        timestamp: Date
      }
    }
  ]
}
```

##### GET `/api/agents/[agentId]/conversations/[conversationId]/messages`
Retrieves all messages for a specific conversation.

**Response**:
```typescript
{
  messages: UIMessage[]
}
```

##### POST `/api/agents/[agentId]/conversations`
Creates a new conversation session.

**Request**:
```typescript
{
  title?: string  // Optional custom title
}
```

**Response**:
```typescript
{
  conversationId: string,
  title: string,
  createdAt: Date
}
```

##### PATCH `/api/agents/[agentId]/conversations/[conversationId]`
Updates conversation metadata (e.g., custom title).

##### DELETE `/api/agents/[agentId]/conversations/[conversationId]`
Soft-deletes a conversation (sets `isActive = false` on all messages).

---

#### 3. Frontend Components

##### AiChatView Component Updates

**New State Variables**:
```typescript
const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
const [conversations, setConversations] = useState<Conversation[]>([]);
const [isLoadingConversations, setIsLoadingConversations] = useState(false);
```

**Initialization Flow**:
1. On component mount:
   - Fetch conversation list via `/api/agents/[agentId]/conversations`
   - Either auto-load most recent conversation OR start with blank new conversation
2. User can select conversations from History tab
3. Selected conversation's messages load into Chat tab via `setMessages()`

**Conversation Switching**:
```typescript
const loadConversation = async (conversationId: string) => {
  setIsLoadingConversations(true);
  try {
    const response = await fetchWithAuth(
      `/api/agents/${page.id}/conversations/${conversationId}/messages`
    );
    if (response.ok) {
      const messages: UIMessage[] = await response.json();
      setMessages(messages); // Update AI SDK state
      setCurrentConversationId(conversationId);
      setActiveTab('chat'); // Switch to chat tab
    }
  } finally {
    setIsLoadingConversations(false);
  }
};
```

**New Conversation Creation**:
```typescript
const createNewConversation = async () => {
  const response = await fetchWithAuth(
    `/api/agents/${page.id}/conversations`,
    { method: 'POST' }
  );
  if (response.ok) {
    const { conversationId } = await response.json();
    setCurrentConversationId(conversationId);
    setMessages([]); // Clear chat
    setActiveTab('chat');
  }
};
```

**Send Message Updates**:
```typescript
// Include conversationId in chat request body
sendMessage(
  { text: input },
  {
    body: {
      chatId: page.id,
      conversationId: currentConversationId, // ← NEW
      selectedProvider,
      selectedModel,
      // ... rest of body
    }
  }
);
```

**Tab Structure**:
```tsx
<TabsList className="grid grid-cols-3">
  <TabsTrigger value="chat">
    <MessageSquare className="h-4 w-4" />
    <span>Chat</span>
  </TabsTrigger>
  <TabsTrigger value="history">
    <History className="h-4 w-4" />
    <span>History</span>
  </TabsTrigger>
  <TabsTrigger value="settings">
    <Settings className="h-4 w-4" />
    <span>Settings</span>
  </TabsTrigger>
</TabsList>
```

##### AgentHistoryTab Component (New)

**File**: `apps/web/src/components/layout/middle-content/page-views/ai-page/AgentHistoryTab.tsx`

**Features**:
- Display all conversations in reverse chronological order (most recent first)
- Each conversation card shows:
  - Title (auto-generated or custom)
  - Last message preview
  - Timestamp (relative: "2 hours ago", "Yesterday")
  - Message count
- Active conversation is highlighted
- Click to load conversation
- "New Conversation" button at top
- Optional delete button per conversation

**UI Structure**:
```tsx
export default function AgentHistoryTab({
  conversations,
  currentConversationId,
  onSelectConversation,
  onCreateNew,
  onDeleteConversation,
  isLoading
}: AgentHistoryTabProps) {
  return (
    <div className="flex flex-col h-full p-4">
      <div className="mb-4">
        <Button onClick={onCreateNew} className="w-full">
          <Plus className="h-4 w-4 mr-2" />
          New Conversation
        </Button>
      </div>

      <ScrollArea className="flex-1">
        {isLoading ? (
          <ConversationListSkeleton />
        ) : conversations.length === 0 ? (
          <EmptyState message="No conversations yet" />
        ) : (
          <div className="space-y-2">
            {conversations.map(conv => (
              <ConversationCard
                key={conv.id}
                conversation={conv}
                isActive={conv.id === currentConversationId}
                onClick={() => onSelectConversation(conv.id)}
                onDelete={() => onDeleteConversation(conv.id)}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
```

**ConversationCard Component**:
```tsx
function ConversationCard({ conversation, isActive, onClick, onDelete }) {
  return (
    <Card
      className={cn(
        "p-3 cursor-pointer hover:bg-accent transition-colors",
        isActive && "bg-accent border-primary"
      )}
      onClick={onClick}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <h4 className="font-medium truncate">{conversation.title}</h4>
          <p className="text-sm text-muted-foreground truncate mt-1">
            {conversation.preview}
          </p>
          <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
            <span>{formatDistanceToNow(conversation.updatedAt)} ago</span>
            <span>•</span>
            <span>{conversation.messageCount} messages</span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  );
}
```

---

#### 4. Backend Changes

##### Update `/api/ai/chat` route

**File**: `apps/web/src/app/api/ai/chat/route.ts`

**Changes**:
```typescript
// Extract conversationId from request body
const { conversationId, chatId, /* ... */ } = await request.json();

// If no conversationId provided, create new conversation
const activeConversationId = conversationId || createId();

// Save user message with conversationId
await db.insert(chatMessages).values({
  id: createId(),
  pageId: chatId,
  conversationId: activeConversationId, // ← NEW
  role: 'user',
  content: JSON.stringify(userMessageParts),
  userId: session.userId,
  // ...
});

// Save assistant response with same conversationId
await db.insert(chatMessages).values({
  id: finalAssistantMessageId,
  pageId: chatId,
  conversationId: activeConversationId, // ← NEW
  role: 'assistant',
  content: JSON.stringify(assistantParts),
  // ...
});
```

##### Update message loading endpoints

**File**: `apps/web/src/app/api/ai/chat/messages/route.ts`

**Changes**:
```typescript
// Add optional conversationId filter
const conversationId = searchParams.get('conversationId');

const dbMessages = await db
  .select()
  .from(chatMessages)
  .where(and(
    eq(chatMessages.pageId, pageId),
    eq(chatMessages.isActive, true),
    conversationId ? eq(chatMessages.conversationId, conversationId) : undefined
  ))
  .orderBy(chatMessages.createdAt);
```

---

#### 5. Fix ask_agent (Make Stateless)

**File**: `apps/web/src/lib/ai/tools/agent-communication-tools.ts`

**Changes**:

**REMOVE these lines (429-437)**:
```typescript
// ❌ DELETE - Loading target agent's conversation history
const agentHistory = await db.select()
  .from(chatMessages)
  .where(and(
    eq(chatMessages.pageId, agentId),
    eq(chatMessages.isActive, true)
  ))
  .orderBy(asc(chatMessages.createdAt))
  .limit(MAX_CONVERSATION_WINDOW);

const historyMessages = agentHistory.map(convertDbMessageToUIMessage);
```

**UPDATE message construction (lines 442-455)**:
```typescript
// ✅ KEEP - Just the user's question, no history
const userMessage: UIMessage = {
  id: `temp-${Date.now()}`,
  role: 'user',
  parts: [{ type: 'text', text: `${context ? `${context}\n\n` : ''}${question}` }]
};

const messages: UIMessage[] = [
  // historyMessages removed - stateless consultation
  userMessage
];
```

**UPDATE tool description**:
```typescript
description: `Consult another AI agent in the workspace for specialized knowledge.

  This tool provides STATELESS consultations - each call is independent with no
  conversation memory. The target agent will not see previous consultation history.

  Use this when you need specialized expertise from another agent. Provide sufficient
  context in your question since the agent won't have conversation history.`,
```

**Result**:
- Each `ask_agent` call is completely independent
- No conversation memory between calls
- Target agent only sees: system prompt + location context + current question
- Global assistant can provide more context in the question parameter if needed

---

#### 6. Add Cross-Agent Search Tools

**File**: `apps/web/src/lib/ai/tools/agent-communication-tools.ts`

##### New Tool: search_agent_conversations

```typescript
export const searchAgentConversations = createTool({
  name: 'search_agent_conversations',
  description: 'Search through all agent conversation histories across the workspace. ' +
    'Use this to find previous discussions, decisions, or information from any agent. ' +
    'Returns matching messages with context (agent name, conversation, timestamp).',
  parameters: z.object({
    query: z.string().describe('Search term or regex pattern to find in message content'),
    agentId: z.string().optional().describe('Optional: Limit search to specific agent'),
    driveId: z.string().optional().describe('Optional: Limit search to agents in specific drive'),
    conversationId: z.string().optional().describe('Optional: Search within specific conversation'),
    limit: z.number().optional().default(20).describe('Maximum number of results to return'),
  }),
  execute: async ({ query, agentId, driveId, conversationId, limit }, executionContext) => {
    const userId = executionContext?.userId;
    if (!userId) {
      return { success: false, error: 'Authentication required' };
    }

    try {
      // Build query with permission filtering
      let queryBuilder = db
        .select({
          message: chatMessages,
          page: pages,
          drive: drives,
        })
        .from(chatMessages)
        .innerJoin(pages, eq(chatMessages.pageId, pages.id))
        .innerJoin(drives, eq(pages.driveId, drives.id))
        .where(
          and(
            eq(chatMessages.isActive, true),
            eq(pages.type, 'AI_CHAT'),
            // Content search - use ILIKE for case-insensitive
            sql`${chatMessages.content} ILIKE ${'%' + query + '%'}`,
            agentId ? eq(pages.id, agentId) : undefined,
            driveId ? eq(drives.id, driveId) : undefined,
            conversationId ? eq(chatMessages.conversationId, conversationId) : undefined
          )
        )
        .orderBy(desc(chatMessages.createdAt))
        .limit(limit);

      const results = await queryBuilder;

      // Filter by user permissions (only show messages from agents user can access)
      const accessibleResults = await Promise.all(
        results.map(async (result) => {
          const accessLevel = await getUserAccessLevel(userId, result.page.id);
          return accessLevel >= AccessLevel.Viewer ? result : null;
        })
      );

      const filteredResults = accessibleResults.filter(r => r !== null);

      return {
        success: true,
        results: filteredResults.map(r => ({
          messageId: r.message.id,
          content: r.message.content,
          role: r.message.role,
          timestamp: r.message.createdAt,
          agentName: r.page.title,
          agentId: r.page.id,
          conversationId: r.message.conversationId,
          driveName: r.drive.name,
          driveId: r.drive.id,
        })),
        totalFound: filteredResults.length,
      };
    } catch (error) {
      console.error('Error searching agent conversations:', error);
      return { success: false, error: 'Failed to search conversations' };
    }
  },
});
```

##### New Tool: list_recent_agent_activity

```typescript
export const listRecentAgentActivity = createTool({
  name: 'list_recent_agent_activity',
  description: 'List recent conversation activity across all agents or filtered by agent/drive. ' +
    'Shows conversation summaries with last message and timestamp.',
  parameters: z.object({
    agentId: z.string().optional().describe('Optional: Specific agent to show activity for'),
    driveId: z.string().optional().describe('Optional: Show agents from specific drive only'),
    limit: z.number().optional().default(10).describe('Number of conversations to return'),
  }),
  execute: async ({ agentId, driveId, limit }, executionContext) => {
    const userId = executionContext?.userId;
    if (!userId) {
      return { success: false, error: 'Authentication required' };
    }

    try {
      // Get recent conversations with last message
      const recentConversations = await db
        .select({
          conversationId: chatMessages.conversationId,
          pageId: chatMessages.pageId,
          agentTitle: pages.title,
          driveId: drives.id,
          driveName: drives.name,
          lastMessageTime: max(chatMessages.createdAt).as('lastMessageTime'),
          messageCount: count(chatMessages.id).as('messageCount'),
        })
        .from(chatMessages)
        .innerJoin(pages, eq(chatMessages.pageId, pages.id))
        .innerJoin(drives, eq(pages.driveId, drives.id))
        .where(
          and(
            eq(chatMessages.isActive, true),
            eq(pages.type, 'AI_CHAT'),
            agentId ? eq(pages.id, agentId) : undefined,
            driveId ? eq(drives.id, driveId) : undefined
          )
        )
        .groupBy(chatMessages.conversationId, chatMessages.pageId, pages.title, drives.id, drives.name)
        .orderBy(desc(sql`lastMessageTime`))
        .limit(limit);

      // Filter by permissions
      const accessibleConversations = await Promise.all(
        recentConversations.map(async (conv) => {
          const accessLevel = await getUserAccessLevel(userId, conv.pageId);
          return accessLevel >= AccessLevel.Viewer ? conv : null;
        })
      );

      const filtered = accessibleConversations.filter(c => c !== null);

      return {
        success: true,
        conversations: filtered,
        totalFound: filtered.length,
      };
    } catch (error) {
      console.error('Error listing recent agent activity:', error);
      return { success: false, error: 'Failed to list activity' };
    }
  },
});
```

---

## Implementation Phases

### Phase 1: Database Schema ✅
1. Add `conversationId` field to `chatMessages` table
2. Add index on `conversationId`
3. Generate and run migration
4. Migrate existing data (assign default conversation IDs)

### Phase 2: API Endpoints ✅
1. Create `/api/agents/[agentId]/conversations` (GET, POST)
2. Create `/api/agents/[agentId]/conversations/[conversationId]/messages` (GET)
3. Create `/api/agents/[agentId]/conversations/[conversationId]` (PATCH, DELETE)
4. Update `/api/ai/chat` to handle `conversationId`
5. Update `/api/ai/chat/messages` to filter by `conversationId`

### Phase 3: Frontend Components ✅
1. Create `AgentHistoryTab` component
2. Update `AiChatView` with conversation state management
3. Add History tab to tab list
4. Implement conversation loading/switching logic
5. Implement new conversation creation

### Phase 4: Fix ask_agent ✅
1. Remove conversation history loading from `ask_agent` tool
2. Update tool description to clarify stateless behavior
3. Test independent consultations

### Phase 5: Add Search Tools ✅
1. Implement `search_agent_conversations` tool
2. Implement `list_recent_agent_activity` tool
3. Register new tools in tool registry
4. Test from global assistant

### Phase 6: Testing & Polish ✅
1. Test conversation creation and switching
2. Test message persistence across sessions
3. Test ask_agent independence
4. Test cross-agent search
5. Add loading states and error handling
6. Polish UI/UX

---

## Success Criteria

- ✅ Opening an AI_CHAT page displays historical messages
- ✅ Page refresh maintains conversation state
- ✅ Users can create multiple conversations with each agent
- ✅ History tab displays all conversations for an agent
- ✅ Clicking a conversation loads its messages into Chat tab
- ✅ `ask_agent` calls are completely independent (no conversation memory)
- ✅ Global assistant can search across all agent conversations
- ✅ Messages are correctly associated with conversations in DB

---

## Migration Notes

**For Existing Users**:
1. All existing messages will be grouped into a single "Default" conversation per agent
2. Conversation ID will be auto-generated based on the first message timestamp
3. No data loss - all existing messages preserved
4. Users can immediately start creating new conversations

**Database Migration**:
```sql
-- Add conversationId column with default value
ALTER TABLE chat_messages ADD COLUMN conversation_id VARCHAR(255);

-- Generate conversation IDs for existing messages (group by pageId)
UPDATE chat_messages cm
SET conversation_id = (
  SELECT CONCAT('conv_', MIN(id))
  FROM chat_messages
  WHERE pageId = cm.pageId
);

-- Make conversationId NOT NULL after backfilling
ALTER TABLE chat_messages ALTER COLUMN conversation_id SET NOT NULL;

-- Add index
CREATE INDEX chat_messages_conversation_id_idx ON chat_messages(conversation_id);
```

---

## Future Enhancements

1. **Conversation Titles**: Allow users to rename conversations
2. **Conversation Search**: Search within a specific conversation
3. **Conversation Export**: Export conversation as markdown/PDF
4. **Conversation Sharing**: Share specific conversations with other users
5. **Conversation Branching**: Fork a conversation at a specific point
6. **Conversation Analytics**: Track token usage, message counts per conversation
