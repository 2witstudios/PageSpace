# AI Audit Tracking Integration

This guide explains how PageSpace tracks AI operations for complete accountability, compliance, and undo capability.

## Overview

PageSpace's AI audit tracking system provides:

- **Complete AI Accountability**: Every AI operation is tracked with full context
- **Tool Call Attribution**: Track which tools were invoked during AI execution
- **Token & Cost Tracking**: Monitor AI usage and costs
- **Change Attribution**: Link AI operations to the pages/permissions they modified
- **Undo Foundation**: Support for reverting changes made by specific AI messages
- **Compliance**: Store prompts and completions for audit/compliance requirements

## Architecture

### Components

1. **AI Operations Table** (`ai_operations`)
   - Stores detailed records of every AI chat interaction
   - Links to audit events for changes made
   - Tracks tokens, costs, tools called, and results

2. **Audit Events Table** (`audit_events`)
   - Master log of all system actions (user and AI)
   - Links back to AI operations via `aiOperationId`
   - Provides foundation for activity feeds and compliance

3. **Page Versions Table** (`page_versions`)
   - Snapshots of page content at specific points in time
   - Links to audit events that triggered the version
   - Enables version history browsing and restoration

### Data Flow

```
User sends message
    ↓
AI Chat Route creates AI Operation
    ↓
AI Operation ID passed to tools via context
    ↓
Tools execute and create audit events (linked to AI Operation)
    ↓
AI completes, updates AI Operation with results
    ↓
Audit events remain linked for "what did this AI message change?" queries
```

## Implementation

### 1. AI Chat Route Integration

The AI chat route (`/apps/web/src/app/api/ai/chat/route.ts`) creates and manages AI operations:

```typescript
import { trackAiOperation } from '@pagespace/lib/audit';

// Create AI operation at start of request
const aiOperation = await trackAiOperation({
  userId,
  agentType: 'ASSISTANT',
  provider: currentProvider,
  model: currentModel,
  operationType: 'conversation',
  prompt: userPromptContent,
  systemPrompt: customSystemPrompt,
  conversationId,
  driveId: pageContext?.driveId,
  pageId: chatId,
  metadata: {
    pageTitle: page.title,
    pageType: page.type,
  },
});

// Pass AI operation ID to tools via context
experimental_context: {
  userId,
  conversationId,
  aiOperationId: aiOperation.id, // Tools receive this
  locationContext: { /* ... */ },
  modelCapabilities: { /* ... */ }
}

// Complete AI operation when done
await aiOperation.complete({
  completion: messageContent,
  actionsPerformed: {
    messageId,
    toolCallsCount: extractedToolCalls.length,
    toolsUsed: extractedToolCalls.map(tc => tc.toolName),
  },
  tokens: {
    input: inputTokens || 0,
    output: outputTokens || 0,
    cost: 0,
  },
});
```

### 2. Tool Context Access

Tools receive the AI operation ID via `experimental_context`:

```typescript
// In page-write-tools.ts
execute: async ({ pageId, content }, { experimental_context: context }) => {
  const userId = (context as ToolExecutionContext)?.userId;
  const aiOperationId = (context as ToolExecutionContext)?.aiOperationId;

  // Use aiOperationId when creating audit events
  await createAuditEvent({
    actionType: 'PAGE_UPDATE',
    entityType: 'PAGE',
    entityId: pageId,
    userId,
    isAiAction: !!aiOperationId,
    aiOperationId, // Link to parent AI operation
    driveId,
    // ...
  });
}
```

### 3. API Route Integration

When tools call API routes (or when external services need to create audit events), they can pass the AI operation ID via header:

```typescript
import { AI_OPERATION_ID_HEADER } from '@pagespace/lib/audit';

// In a tool that calls an API route
const response = await fetch('/api/pages/create', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    [AI_OPERATION_ID_HEADER]: aiOperationId, // Pass AI operation ID
  },
  body: JSON.stringify({ /* ... */ }),
});
```

Then in the API route:

```typescript
import { extractAiOperationId, isAiInitiatedRequest } from '@pagespace/lib/audit';

export async function POST(request: Request) {
  const aiOperationId = extractAiOperationId(request);
  const isAiAction = isAiInitiatedRequest(request);

  // Create audit event with AI attribution
  await createAuditEvent({
    // ...
    isAiAction,
    aiOperationId, // Link to parent AI operation
  });
}
```

## Querying AI Operations

### Get AI operations for a user

```typescript
import { getUserAiOperations } from '@pagespace/lib/audit';

const operations = await getUserAiOperations(userId, 100);
```

### Get AI operations for a page

```typescript
import { getPageAiOperations } from '@pagespace/lib/audit';

const operations = await getPageAiOperations(pageId);
```

### Get AI operations for a conversation

```typescript
import { getConversationAiOperations } from '@pagespace/lib/audit';

const operations = await getConversationAiOperations(conversationId);
```

### Get AI usage statistics

```typescript
import { getAiUsageSummary } from '@pagespace/lib/audit';

const stats = await getAiUsageSummary(userId, 30); // Last 30 days
// Returns: { total, completed, failed, successRate, totalTokens, totalCost, ... }
```

## Querying Related Audit Events

### Get all changes made by an AI operation

```typescript
import { getOperationEvents } from '@pagespace/lib/audit';

// Get all audit events linked to this AI operation
const events = await getOperationEvents(aiOperationId);

// Each event shows what changed
events.forEach(event => {
  console.log('Action:', event.actionType);
  console.log('Entity:', event.entityType, event.entityId);
  console.log('Before:', event.beforeState);
  console.log('After:', event.afterState);
  console.log('Changes:', event.changes);
});
```

### Build "What did this AI message change?" view

```typescript
// Get AI operation by message ID
const [operation] = await db.query.aiOperations.findMany({
  where: eq(aiOperations.messageId, messageId),
  limit: 1,
});

if (operation) {
  // Get all changes made by this operation
  const changes = await getOperationEvents(operation.id);

  // Display to user:
  // "This AI message made 5 changes:"
  // 1. Created page "Project Plan"
  // 2. Updated page "Requirements"
  // 3. Moved page "Notes" to "Archive"
}
```

## Undo Support (Future)

The audit infrastructure provides the foundation for undo functionality:

```typescript
// Future: Undo an AI operation
async function undoAiOperation(operationId: string) {
  // 1. Get all audit events for this operation
  const events = await getOperationEvents(operationId);

  // 2. Reverse each change using beforeState
  for (const event of events.reverse()) {
    await restoreEntityState(event.entityType, event.entityId, event.beforeState);
  }

  // 3. Mark operation as cancelled
  await db.update(aiOperations)
    .set({ status: 'cancelled' })
    .where(eq(aiOperations.id, operationId));
}
```

## Best Practices

### 1. Always Create AI Operations

Every AI interaction should create an AI operation record, even if it doesn't modify data:

```typescript
const aiOperation = await trackAiOperation({
  userId,
  agentType: 'ASSISTANT',
  provider,
  model,
  operationType: 'conversation', // or 'edit', 'generate', 'analyze'
  prompt: userMessage,
  // ...
});
```

### 2. Pass AI Operation ID Through Context

Always include `aiOperationId` in `experimental_context`:

```typescript
experimental_context: {
  userId,
  aiOperationId: aiOperation.id, // Critical for attribution
  // ...
}
```

### 3. Link Audit Events to AI Operations

When creating audit events from AI-initiated actions:

```typescript
await createAuditEvent({
  // ...
  isAiAction: true,
  aiOperationId: context.aiOperationId,
});
```

### 4. Complete Operations with Full Data

Always complete AI operations with comprehensive data:

```typescript
await aiOperation.complete({
  completion: responseText,
  actionsPerformed: {
    pagesCreated: 3,
    pagesUpdated: 2,
    toolsUsed: ['create_page', 'update_page'],
  },
  tokens: {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cost: calculateCost(usage),
  },
});
```

### 5. Handle Failures Gracefully

Always handle failures and cancellations:

```typescript
try {
  // AI operation
} catch (error) {
  await aiOperation.fail(error.message);
  throw error;
}

// On user abort
onAbort: async () => {
  await aiOperation.cancel();
}
```

## Database Schema

### AI Operations

```sql
CREATE TABLE ai_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_type ai_agent_type NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  prompt TEXT,
  system_prompt TEXT,
  conversation_id TEXT,
  message_id TEXT,
  drive_id TEXT,
  page_id TEXT,
  tools_called JSONB,
  tool_results JSONB,
  completion TEXT,
  actions_performed JSONB,
  duration INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_cost INTEGER,
  status TEXT DEFAULT 'completed',
  error TEXT,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);
```

### Audit Events

```sql
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  action_type audit_action_type NOT NULL,
  entity_type audit_entity_type NOT NULL,
  entity_id TEXT NOT NULL,
  user_id TEXT,
  is_ai_action BOOLEAN DEFAULT FALSE,
  ai_operation_id TEXT, -- Links to ai_operations
  drive_id TEXT,
  before_state JSONB,
  after_state JSONB,
  changes JSONB,
  description TEXT,
  reason TEXT,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
```

## Security Considerations

1. **Permission Enforcement**: AI operations respect user permissions - no elevation
2. **Audit Trail Immutability**: Audit events are write-once, never modified
3. **Sensitive Data**: Prompts may contain sensitive information - handle with care
4. **Access Control**: Only users with appropriate permissions can view AI operations
5. **Retention**: Consider data retention policies for compliance

## Performance Considerations

1. **Indexes**: All tables have appropriate indexes for common queries
2. **Archival**: Old AI operations can be archived to cold storage
3. **Pagination**: Always paginate when querying large result sets
4. **Async Completion**: AI operation completion is async and doesn't block responses

## Related Documentation

- [Audit Trail and Versioning Schema](/home/user/PageSpace/packages/db/src/schema/audit.ts)
- [Audit Utilities](/home/user/PageSpace/packages/lib/src/audit/)
- [AI Chat Route](/home/user/PageSpace/apps/web/src/app/api/ai/chat/route.ts)
- [Tool Execution Context](/home/user/PageSpace/apps/web/src/lib/ai/types.ts)
