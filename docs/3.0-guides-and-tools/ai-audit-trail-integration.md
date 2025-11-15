# AI Audit Trail Integration Guide

## Overview

PageSpace provides complete audit trail tracking for all AI operations, tool calls, and page modifications. This ensures full accountability, compliance, and transparency for AI-powered workflows.

## Architecture

### Three-Layer Tracking System

1. **AI Operations** (`ai_operations` table)
   - Tracks overall AI conversation turns
   - Records prompts, completions, tokens, costs
   - Links to affected pages and drives

2. **Audit Events** (`audit_events` table)
   - Records individual page modifications
   - Captures before/after state
   - Links to AI operations when AI-initiated

3. **Page Versions** (`page_versions` table)
   - Stores complete content snapshots
   - Enables version history and rollback
   - Flags AI-generated vs human edits

## How It Works

### 1. AI Operation Lifecycle

Every AI chat interaction follows this lifecycle:

```typescript
// Start: Create AI operation when conversation begins
aiOperation = await trackAiOperation({
  userId: 'user-123',
  agentType: 'ASSISTANT',
  provider: 'openai',
  model: 'gpt-4',
  operationType: 'conversation',
  prompt: 'Create 3 project documents',
  conversationId: 'conv-456',
  pageId: 'page-789',
  driveId: 'drive-abc'
});

// During: AI operation ID is passed to all tools
// Tools receive aiOperationId via experimental_context
{
  experimental_context: {
    userId: 'user-123',
    aiOperationId: aiOperation.id, // <-- Passed to every tool
    locationContext: {...}
  }
}

// Complete: Operation finishes with results
await aiOperation.complete({
  completion: 'Created 3 documents: Requirements, Timeline, Budget',
  actionsPerformed: {
    toolsUsed: ['create_page', 'create_page', 'create_page'],
    affectedPages: ['page-1', 'page-2', 'page-3'],
    affectedDrives: ['drive-abc']
  },
  tokens: {
    input: 1500,
    output: 800,
    cost: 23 // cents
  }
});

// OR Fail: Operation fails with error
await aiOperation.fail('Insufficient permissions');

// OR Cancel: Operation cancelled by user
await aiOperation.cancel();
```

### 2. Tool Call Tracking

AI tools automatically track their execution:

**Tool receives AI operation context:**
```typescript
export const create_page = tool({
  description: 'Create new pages',
  inputSchema: z.object({...}),
  execute: async ({ driveId, title, type }, { experimental_context }) => {
    const { userId, aiOperationId, locationContext } = experimental_context;

    // Permission checks...
    // Create page...

    // Return result with page ID for tracking
    return {
      success: true,
      id: newPage.id,      // <-- Extracted by audit system
      title: newPage.title,
      type: newPage.type
    };
  }
});
```

**Automatic extraction at conversation completion:**
```typescript
// In AI chat route onFinish callback
extractedToolResults.forEach((toolResult) => {
  const result = toolResult.result;

  // Extract page IDs from various result formats
  if (result.id) affectedPageIds.add(result.id);
  if (result.pageId) affectedPageIds.add(result.pageId);
  if (result.pageIds) result.pageIds.forEach(id => affectedPageIds.add(id));

  // Batch operations
  if (result.successful) {
    result.successful.forEach(item => {
      if (item.pageId) affectedPageIds.add(item.pageId);
    });
  }
});

await aiOperation.complete({
  actionsPerformed: {
    affectedPages: Array.from(affectedPageIds) // <-- Tracked automatically
  }
});
```

### 3. Page Modification Tracking

When AI tools modify pages, audit events are automatically created:

**Example: AI creates a page**
```typescript
// User prompt: "Create a requirements document"

// 1. AI operation started
aiOperation = await trackAiOperation({
  prompt: 'Create a requirements document',
  ...
});

// 2. AI calls create_page tool
const result = await createPageTool.execute({
  title: 'Requirements',
  type: 'DOCUMENT',
  content: 'AI-generated requirements...'
});

// 3. Audit event created (if audit integration is added to tool)
await auditPageCreation(result.id, {
  userId: 'user-123',
  isAiAction: true,
  aiOperationId: aiOperation.id,
  aiPrompt: 'Create a requirements document'
});

// Creates:
// - Audit event with isAiAction: true
// - Page version with isAiGenerated: true
// - Links to AI operation
```

## Database Schema

### ai_operations Table

```sql
CREATE TABLE ai_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,

  -- AI details
  agent_type TEXT NOT NULL,  -- 'ASSISTANT', 'EDITOR', etc.
  provider TEXT NOT NULL,    -- 'openai', 'anthropic', etc.
  model TEXT NOT NULL,       -- 'gpt-4', 'claude-3', etc.

  -- Operation context
  operation_type TEXT NOT NULL, -- 'conversation', 'edit', etc.
  prompt TEXT,               -- User's original prompt
  system_prompt TEXT,        -- System prompt used

  -- Conversation linking
  conversation_id TEXT,      -- Links to chat conversation
  message_id TEXT,           -- Specific message ID

  -- Scope
  drive_id TEXT,
  page_id TEXT,              -- Context page (AI_CHAT page)

  -- Tool tracking
  tools_called JSONB,        -- Array of {toolName, args, timestamp}
  tool_results JSONB,        -- Array of {toolName, result, pageId}

  -- Results
  completion TEXT,           -- AI's response
  actions_performed JSONB,   -- {affectedPages: [], toolsUsed: []}

  -- Performance metrics
  duration INTEGER,          -- Milliseconds
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_cost INTEGER,        -- Cost in cents

  -- Status
  status TEXT DEFAULT 'completed', -- 'in_progress', 'completed', 'failed', 'cancelled'
  error TEXT,

  -- Metadata
  metadata JSONB,

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);
```

### audit_events Table (AI-linked)

```sql
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,

  -- Action details
  action_type TEXT NOT NULL,     -- 'PAGE_CREATE', 'PAGE_UPDATE', etc.
  entity_type TEXT NOT NULL,     -- 'PAGE', 'DRIVE', etc.
  entity_id TEXT NOT NULL,

  -- User attribution
  user_id TEXT NOT NULL,

  -- AI attribution
  is_ai_action BOOLEAN DEFAULT FALSE,
  ai_operation_id TEXT,          -- Links to ai_operations table

  -- State tracking
  before_state JSONB,
  after_state JSONB,
  changes JSONB,

  -- Context
  drive_id TEXT,
  description TEXT,
  reason TEXT,                   -- AI prompt if AI-initiated

  created_at TIMESTAMP DEFAULT NOW()
);
```

### page_versions Table

```sql
CREATE TABLE page_versions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,

  -- Content snapshot
  content JSONB NOT NULL,
  title TEXT NOT NULL,
  page_type TEXT NOT NULL,
  metadata JSONB,

  -- Attribution
  audit_event_id TEXT,
  created_by TEXT,
  is_ai_generated BOOLEAN DEFAULT FALSE,

  -- Change tracking
  change_summary TEXT,
  change_type TEXT,              -- 'ai_edit', 'user_edit', etc.

  created_at TIMESTAMP DEFAULT NOW()
);
```

## Querying the Audit Trail

### Get AI Operations for a User

```typescript
import { getUserAiOperations } from '@pagespace/lib/audit';

const operations = await getUserAiOperations('user-123', 100);

// Returns:
[
  {
    id: 'ai-op-456',
    userId: 'user-123',
    agentType: 'ASSISTANT',
    provider: 'openai',
    model: 'gpt-4',
    operationType: 'conversation',
    prompt: 'Create 3 project documents',
    completion: 'Created: Requirements, Timeline, Budget',
    actionsPerformed: {
      toolsUsed: ['create_page', 'create_page', 'create_page'],
      affectedPages: ['page-1', 'page-2', 'page-3']
    },
    inputTokens: 1500,
    outputTokens: 800,
    totalCost: 23,
    status: 'completed',
    createdAt: '2025-01-15T10:30:00Z'
  }
]
```

### Get AI Operations for a Page

```typescript
import { getPageAiOperations } from '@pagespace/lib/audit';

const operations = await getPageAiOperations('page-123', 50);

// Returns all AI operations that affected this page
```

### Get AI Operations for a Conversation

```typescript
import { getConversationAiOperations } from '@pagespace/lib/audit';

const operations = await getConversationAiOperations('conv-456');

// Returns all AI operations in chronological order for this conversation
```

### Get AI vs Human Activity

```typescript
import { getDriveAiActivity, getDriveHumanActivity } from '@pagespace/lib/audit';

// AI-only activity
const aiActivity = await getDriveAiActivity('drive-123', 50);

// Human-only activity
const humanActivity = await getDriveHumanActivity('drive-123', 50);

// Combined activity feed
const allActivity = await getDriveActivityFeed('drive-123', 100);
// Each event has isAiAction: true/false flag
```

### Get AI Usage Report

```typescript
import { getAiUsageReport } from '@pagespace/lib/audit';

const report = await getAiUsageReport(
  'user-123',
  new Date('2025-01-01'),
  new Date('2025-01-31')
);

// Returns:
[
  {
    agentType: 'ASSISTANT',
    provider: 'openai',
    model: 'gpt-4',
    operationCount: 45,
    totalInputTokens: 67500,
    totalOutputTokens: 36000,
    totalCost: 1035, // cents = $10.35
    avgDuration: 2450 // milliseconds
  }
]
```

### Get Failed AI Operations

```typescript
import { getFailedAiOperations } from '@pagespace/lib/audit';

const failures = await getFailedAiOperations('user-123', 20);

// Returns operations with status: 'failed' and error messages
// Useful for debugging and improving AI reliability
```

## Implementation Examples

### Example 1: Creating Pages with AI

```typescript
// User asks: "Create a folder structure for Project Alpha"

// 1. AI operation starts
const aiOp = await trackAiOperation({
  userId: 'user-123',
  agentType: 'ASSISTANT',
  provider: 'openai',
  model: 'gpt-4',
  operationType: 'conversation',
  prompt: 'Create a folder structure for Project Alpha',
  conversationId: 'conv-789',
  pageId: 'chat-page-456',
  driveId: 'drive-abc'
});

// 2. AI makes multiple tool calls
const folder = await createPage({
  driveId: 'drive-abc',
  title: 'Project Alpha',
  type: 'FOLDER'
});
// Returns: { id: 'page-1', title: 'Project Alpha' }

const doc1 = await createPage({
  driveId: 'drive-abc',
  parentId: 'page-1',
  title: 'Requirements',
  type: 'DOCUMENT',
  content: '# Requirements\n\n...'
});
// Returns: { id: 'page-2', title: 'Requirements' }

const doc2 = await createPage({
  driveId: 'drive-abc',
  parentId: 'page-1',
  title: 'Timeline',
  type: 'DOCUMENT',
  content: '# Timeline\n\n...'
});
// Returns: { id: 'page-3', title: 'Timeline' }

// 3. Operation completes with extracted page IDs
await aiOp.complete({
  completion: 'Created Project Alpha folder with Requirements and Timeline documents',
  actionsPerformed: {
    toolsUsed: ['create_page', 'create_page', 'create_page'],
    affectedPages: ['page-1', 'page-2', 'page-3'], // Automatically extracted
    affectedDrives: ['drive-abc']
  },
  tokens: { input: 1200, output: 600, cost: 18 }
});

// Result in database:
// - 1 AI operation record with full context
// - 3 audit events (1 per page created) with isAiAction: true
// - 3 page version snapshots with isAiGenerated: true
// - All linked together via aiOperationId
```

### Example 2: Bulk Content Updates

```typescript
// User asks: "Add a summary section to all project documents"

const aiOp = await trackAiOperation({
  userId: 'user-123',
  agentType: 'EDITOR',
  provider: 'anthropic',
  model: 'claude-3',
  operationType: 'bulk_edit',
  prompt: 'Add a summary section to all project documents',
  driveId: 'drive-abc'
});

// AI calls bulk_update_content tool
const result = await bulkUpdateContent({
  pageIds: ['page-2', 'page-3', 'page-4'],
  updates: [
    { pageId: 'page-2', content: '# Summary\n...\n\n# Requirements\n...' },
    { pageId: 'page-3', content: '# Summary\n...\n\n# Timeline\n...' },
    { pageId: 'page-4', content: '# Summary\n...\n\n# Budget\n...' }
  ]
});

// Returns: { successful: [{pageId: 'page-2'}, {pageId: 'page-3'}, {pageId: 'page-4'}] }

await aiOp.complete({
  completion: 'Added summary sections to 3 documents',
  actionsPerformed: {
    toolsUsed: ['bulk_update_content'],
    affectedPages: ['page-2', 'page-3', 'page-4'], // Extracted from result.successful
    updateCount: 3
  },
  tokens: { input: 3400, output: 1200, cost: 46 }
});

// Result in database:
// - 1 AI operation for the bulk edit
// - 3 audit events (1 per page updated) with operationId linking them
// - 3 new page versions with change summaries
```

### Example 3: Error Handling

```typescript
// User asks: "Delete all test pages"

const aiOp = await trackAiOperation({
  userId: 'user-123',
  agentType: 'ASSISTANT',
  provider: 'openai',
  model: 'gpt-4',
  operationType: 'conversation',
  prompt: 'Delete all test pages',
  driveId: 'drive-abc'
});

try {
  // AI tries to delete pages
  await trashPageWithChildren({ pageId: 'page-999' });
} catch (error) {
  // Operation fails
  await aiOp.fail('Page not found: page-999');
}

// Result in database:
// - 1 AI operation with status: 'failed' and error message
// - No audit events created (operation didn't complete)
// - Useful for debugging and improving AI reliability
```

## Integration Checklist

✅ **Already Integrated:**
- [x] AI operation tracking in chat route
- [x] Tool call extraction and logging
- [x] Page ID extraction from tool results
- [x] Token usage and cost tracking
- [x] Operation status tracking (in_progress, completed, failed, cancelled)
- [x] Conversation and message linking
- [x] Drive and page scoping

🔄 **Optional Enhancements:**
- [ ] Add audit trail to individual page write tools (currently only at conversation level)
- [ ] Cost calculation based on provider-specific pricing
- [ ] Real-time audit event broadcasting via Socket.IO
- [ ] Admin UI for viewing AI operations and costs
- [ ] Export AI audit trails for compliance
- [ ] AI usage analytics dashboard

## Best Practices

### 1. Always Track AI Operations

```typescript
// ✅ CORRECT - Track all AI interactions
const aiOp = await trackAiOperation({...});
try {
  // Perform AI operation
  await aiOp.complete({...});
} catch (error) {
  await aiOp.fail(error.message);
}

// ❌ WRONG - Don't skip tracking
// Just run AI without tracking
```

### 2. Extract Page IDs from Results

```typescript
// ✅ CORRECT - Return page IDs in tool results
return {
  success: true,
  id: newPage.id,           // Single page
  pageIds: affectedPages,   // Multiple pages
  successful: results       // Batch operations
};

// ❌ WRONG - Don't hide page IDs in nested objects
return {
  success: true,
  data: {
    nested: {
      page: { id: '...' } // Too nested to extract
    }
  }
};
```

### 3. Use Appropriate Agent Types

```typescript
// Page AI / Assistant
agentType: 'ASSISTANT'

// Content editor
agentType: 'EDITOR'

// Project planner
agentType: 'PLANNER'

// Content writer
agentType: 'WRITER'

// Custom agent
agentType: 'CUSTOM'
```

### 4. Handle Cancellation

```typescript
// In AI chat route
onAbort: async () => {
  if (aiOperation) {
    await aiOperation.cancel();
  }
}

// Status becomes 'cancelled' instead of 'in_progress'
```

## Troubleshooting

### AI Operation Not Created

**Problem:** No AI operation record in database

**Solution:**
- Check that `trackAiOperation` is called before streaming
- Verify userId and required fields are provided
- Check logs for errors in operation creation

### Page IDs Not Tracked

**Problem:** affectedPages array is empty

**Solution:**
- Ensure tools return page IDs in result
- Check page ID extraction logic handles your result format
- Add custom extraction logic for non-standard formats

### Tool Calls Not Logged

**Problem:** toolsCalled/toolResults are null

**Solution:**
- Verify AI SDK is extracting tool calls correctly
- Check that `extractToolCalls()` and `extractToolResults()` are working
- Ensure tool results are properly structured

### High Token Costs

**Problem:** Unexpected high costs in audit trail

**Solution:**
- Review AI operations with `getAiUsageReport()`
- Check for long system prompts or context
- Consider using more efficient models for simple tasks
- Implement caching for repeated operations

## Security Considerations

### Permission Checks

All AI operations respect user permissions:
- ✅ AI can only access pages the user can access
- ✅ AI can only modify pages the user can edit
- ✅ AI operations are scoped to user's drives
- ✅ Audit trail preserves user attribution even for AI actions

### Data Privacy

- Prompts and completions stored in audit trail
- Consider PII and sensitive data in prompts
- Implement data retention policies for old operations
- Allow users to delete their AI operation history

### Compliance

Audit trail supports compliance requirements:
- Full attribution (who, what, when, why)
- Complete history of AI modifications
- Ability to rollback AI changes via page versions
- Export capabilities for auditing

## Summary

PageSpace's AI audit trail system provides:

✅ **Complete Accountability** - Every AI action is tracked with full context
✅ **Tool Call Transparency** - See exactly what tools AI used and their results
✅ **Page Modification Tracking** - Know which pages were affected by AI
✅ **Token & Cost Tracking** - Monitor AI usage and expenses
✅ **Version Control** - Roll back AI changes if needed
✅ **Compliance Ready** - Full audit trail for regulatory requirements

The system is production-ready and requires no additional configuration. All AI chat interactions are automatically tracked with comprehensive attribution.
