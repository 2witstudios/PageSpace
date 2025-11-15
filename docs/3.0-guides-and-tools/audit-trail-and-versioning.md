# Audit Trail and Versioning System

## Overview

PageSpace's audit trail and versioning system provides comprehensive tracking of all user and AI actions, content versioning, and AI operation attribution. The system is designed to support:

- Complete audit trail of all system changes
- Page content versioning with full snapshots
- AI agent attribution and operation tracking
- Drive-scoped access control for multi-tenant security
- Efficient querying for activity feeds, page history, and admin reports
- Future undo/redo functionality

## Architecture

### Three Core Tables

The system is built on three interconnected tables:

1. **`audit_events`** - Master log of all actions (user and AI)
2. **`page_versions`** - Historical snapshots of page content
3. **`ai_operations`** - Detailed AI operation tracking and attribution

### Data Flow

```
User/AI Action
    ↓
audit_events (logged immediately)
    ↓
page_versions (if page content changed)
    ↑
ai_operations (if AI-initiated)
```

## Table Design

### audit_events

The central audit log that captures every meaningful action in PageSpace.

**Key Features:**
- Polymorphic entity tracking (pages, drives, permissions, files, etc.)
- User and AI actor attribution
- Drive-scoped for access control
- Before/after state snapshots in JSONB
- Operation grouping for bulk changes
- Request correlation via requestId

**Schema Highlights:**

```typescript
{
  id: CUID2,
  actionType: 'PAGE_UPDATE' | 'PERMISSION_GRANT' | 'AI_EDIT' | ...,
  entityType: 'PAGE' | 'DRIVE' | 'PERMISSION' | ...,
  entityId: string,

  // Actor
  userId: foreign key to users,
  isAiAction: boolean,
  aiOperationId: foreign key to ai_operations,

  // Scope
  driveId: foreign key to drives (CASCADE delete),

  // Change tracking
  beforeState: JSONB,   // Previous state
  afterState: JSONB,    // New state
  changes: JSONB,       // Specific fields changed

  // Context
  description: string,
  reason: string,       // Why (from prompt or user)
  metadata: JSONB,

  // Request correlation
  requestId: string,
  sessionId: string,
  ipAddress: string,
  userAgent: string,

  // Grouping
  operationId: string,  // Group related changes
  parentEventId: foreign key (self-reference),

  createdAt: timestamp
}
```

**Index Strategy:**

```typescript
// Core queries (drive activity feed, user timeline)
driveId + createdAt
userId + createdAt
entityType + entityId + createdAt

// Filtering
actionType
isAiAction + createdAt
aiOperationId

// Grouping
operationId
requestId

// Archival/cleanup
createdAt
```

### page_versions

Full snapshots of page content at specific points in time.

**Design Decision: Full Snapshots vs Diffs**

We chose **full snapshots** for several reasons:
- **Simplicity**: No complex diff algorithms needed
- **Reliability**: Every version is self-contained and independently restorable
- **Performance**: No need to reconstruct state by replaying diffs
- **Flexibility**: Can easily add diff generation on-the-fly for comparison
- **Storage**: Modern compression makes full snapshots reasonable

**Schema Highlights:**

```typescript
{
  id: CUID2,
  pageId: foreign key to pages (CASCADE delete),

  // Version tracking
  versionNumber: integer,  // Sequential: 1, 2, 3, ...

  // Content snapshot
  content: JSONB,          // Full content
  title: string,
  pageType: string,
  metadata: JSONB,         // aiModel, systemPrompt, etc.

  // Attribution
  auditEventId: foreign key to audit_events,
  createdBy: foreign key to users,
  isAiGenerated: boolean,

  // Size tracking
  contentSize: integer,    // Bytes

  // Summary
  changeSummary: string,   // Brief description
  changeType: 'minor' | 'major' | 'ai_edit' | 'user_edit',

  createdAt: timestamp
}
```

**Index Strategy:**

```typescript
// Version browsing
pageId + versionNumber
pageId + createdAt

// User tracking
createdBy + createdAt

// AI filtering
isAiGenerated

// Audit linkage
auditEventId

// Archival
createdAt
```

### ai_operations

Detailed tracking of AI agent actions with full context.

**Purpose:**
- Link AI actions back to original user prompts
- Track which agent/model performed actions
- Store tool calls and results
- Enable AI usage analysis and cost attribution

**Schema Highlights:**

```typescript
{
  id: CUID2,

  // User who initiated
  userId: foreign key to users (CASCADE delete),

  // AI details
  agentType: 'ASSISTANT' | 'EDITOR' | 'RESEARCHER' | ...,
  provider: 'openai' | 'anthropic' | 'google' | ...,
  model: string,

  // Operation
  operationType: 'edit' | 'generate' | 'analyze' | 'tool_call',
  prompt: text,
  systemPrompt: text,

  // Context
  conversationId: string,
  messageId: string,
  driveId: foreign key to drives,
  pageId: foreign key to pages,

  // Tool usage
  toolsCalled: JSONB,      // Array of tools used
  toolResults: JSONB,      // Results from tools

  // Results
  completion: text,
  actionsPerformed: JSONB, // Summary of actions

  // Performance
  duration: integer,       // Milliseconds
  inputTokens: integer,
  outputTokens: integer,
  totalCost: integer,      // Cents

  // Status
  status: 'in_progress' | 'completed' | 'failed' | 'cancelled',
  error: text,

  createdAt: timestamp,
  completedAt: timestamp
}
```

**Index Strategy:**

```typescript
// User tracking
userId + createdAt

// Drive scoping
driveId + createdAt

// Conversation tracking
conversationId
messageId

// Page tracking
pageId + createdAt

// Performance analysis
agentType + createdAt
provider + model

// Status filtering
status

// Time-series
createdAt
```

## Enums

### auditActionType

```typescript
'PAGE_CREATE', 'PAGE_UPDATE', 'PAGE_DELETE', 'PAGE_RESTORE',
'PAGE_MOVE', 'PAGE_RENAME', 'PAGE_DUPLICATE',
'PERMISSION_GRANT', 'PERMISSION_REVOKE', 'PERMISSION_UPDATE',
'DRIVE_CREATE', 'DRIVE_UPDATE', 'DRIVE_DELETE', 'DRIVE_RESTORE',
'MEMBER_ADD', 'MEMBER_REMOVE', 'MEMBER_UPDATE_ROLE',
'FILE_UPLOAD', 'FILE_DELETE', 'FILE_UPDATE',
'MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE',
'AI_EDIT', 'AI_GENERATE', 'AI_TOOL_CALL', 'AI_CONVERSATION',
'SETTINGS_UPDATE', 'EXPORT', 'IMPORT'
```

### auditEntityType

```typescript
'PAGE', 'DRIVE', 'PERMISSION', 'MEMBER', 'FILE', 'MESSAGE',
'SETTINGS', 'AI_OPERATION'
```

### aiAgentType

```typescript
'ASSISTANT',   // General assistant
'EDITOR',      // Content editing
'RESEARCHER',  // Information gathering
'CODER',       // Code generation
'ANALYST',     // Data analysis
'WRITER',      // Content creation
'REVIEWER',    // Content review
'CUSTOM'       // User-defined agent
```

## Design Decisions

### 1. Drive-Scoped Access Control

Every audit event includes `driveId` for multi-tenant security:
- Users only see audit logs for drives they have access to
- `CASCADE` delete ensures audit logs are cleaned up with drives
- Efficient querying with `driveId + createdAt` index

### 2. JSONB for Flexibility

Using JSONB for `beforeState`, `afterState`, `changes`, and `metadata`:
- **Flexibility**: Different entity types have different properties
- **Queryability**: Can use JSONB operators and GIN indexes
- **Evolution**: Schema can evolve without migrations
- **Compression**: PostgreSQL automatically compresses JSONB

### 3. Full Snapshots for Versions

Instead of diffs:
- **Simplicity**: No complex diff/patch algorithms
- **Reliability**: Every version is independently restorable
- **Performance**: No state reconstruction needed
- **Future-proof**: Can add diff generation later if needed

### 4. Operation Grouping

Multiple ways to group related events:
- **operationId**: Logical grouping (e.g., one AI prompt → many page edits)
- **requestId**: Technical correlation (single API request)
- **parentEventId**: Hierarchical relationships

### 5. Soft Actor References

`userId` uses `SET NULL` on delete:
- Preserves audit trail even if user is deleted
- Can show "Deleted User" in UI
- Maintains data integrity for compliance

### 6. AI Attribution Chain

```
User → AI Operation → Audit Events → Page Versions
```

Complete traceability from user prompt to specific changes.

## Query Patterns

### 1. Drive Activity Feed

**Use Case**: Show recent activity in a drive

```typescript
import { db, auditEvents, users, eq, desc, and } from '@pagespace/db';

async function getDriveActivity(driveId: string, limit = 50) {
  return await db.query.auditEvents.findMany({
    where: eq(auditEvents.driveId, driveId),
    orderBy: [desc(auditEvents.createdAt)],
    limit,
    with: {
      user: {
        columns: { id: true, name: true, image: true }
      },
      aiOperation: {
        columns: { agentType: true, model: true, prompt: true }
      }
    }
  });
}
```

**Performance**: Uses `driveId + createdAt` index

### 2. User Activity Timeline

**Use Case**: Show all actions by a specific user

```typescript
async function getUserActivity(userId: string, limit = 100) {
  return await db.query.auditEvents.findMany({
    where: eq(auditEvents.userId, userId),
    orderBy: [desc(auditEvents.createdAt)],
    limit,
    with: {
      drive: {
        columns: { id: true, name: true }
      }
    }
  });
}
```

**Performance**: Uses `userId + createdAt` index

### 3. Page History

**Use Case**: Show all changes to a specific page

```typescript
async function getPageHistory(pageId: string) {
  return await db.query.auditEvents.findMany({
    where: and(
      eq(auditEvents.entityType, 'PAGE'),
      eq(auditEvents.entityId, pageId)
    ),
    orderBy: [desc(auditEvents.createdAt)],
    with: {
      user: true,
      aiOperation: true
    }
  });
}
```

**Performance**: Uses `entityType + entityId + createdAt` index

### 4. Page Version List

**Use Case**: Show all versions of a page

```typescript
import { pageVersions } from '@pagespace/db';

async function getPageVersions(pageId: string) {
  return await db.query.pageVersions.findMany({
    where: eq(pageVersions.pageId, pageId),
    orderBy: [desc(pageVersions.versionNumber)],
    with: {
      createdByUser: {
        columns: { id: true, name: true, image: true }
      },
      auditEvent: {
        columns: { actionType: true, description: true }
      }
    }
  });
}
```

**Performance**: Uses `pageId + versionNumber` index

### 5. Get Specific Version

**Use Case**: Retrieve content of a specific version

```typescript
async function getPageVersion(pageId: string, versionNumber: number) {
  return await db.query.pageVersions.findFirst({
    where: and(
      eq(pageVersions.pageId, pageId),
      eq(pageVersions.versionNumber, versionNumber)
    )
  });
}
```

**Performance**: Uses `pageId + versionNumber` index

### 6. Compare Versions

**Use Case**: Compare two versions for diff display

```typescript
async function compareVersions(
  pageId: string,
  fromVersion: number,
  toVersion: number
) {
  const versions = await db.query.pageVersions.findMany({
    where: and(
      eq(pageVersions.pageId, pageId),
      inArray(pageVersions.versionNumber, [fromVersion, toVersion])
    ),
    orderBy: [asc(pageVersions.versionNumber)]
  });

  if (versions.length !== 2) {
    throw new Error('One or both versions not found');
  }

  return {
    from: versions[0],
    to: versions[1],
    // Client-side diff can be computed from content fields
  };
}
```

### 7. AI Operations Report

**Use Case**: Analyze AI usage by user, model, or time period

```typescript
import { aiOperations, sql } from '@pagespace/db';

async function getAiUsageReport(
  userId: string,
  startDate: Date,
  endDate: Date
) {
  return await db
    .select({
      agentType: aiOperations.agentType,
      provider: aiOperations.provider,
      model: aiOperations.model,
      operationCount: count(aiOperations.id),
      totalInputTokens: sum(aiOperations.inputTokens),
      totalOutputTokens: sum(aiOperations.outputTokens),
      totalCost: sum(aiOperations.totalCost),
      avgDuration: avg(aiOperations.duration)
    })
    .from(aiOperations)
    .where(
      and(
        eq(aiOperations.userId, userId),
        gte(aiOperations.createdAt, startDate),
        lte(aiOperations.createdAt, endDate)
      )
    )
    .groupBy(
      aiOperations.agentType,
      aiOperations.provider,
      aiOperations.model
    );
}
```

### 8. Filter Activity: AI vs Human

**Use Case**: Show only AI actions or only human actions

```typescript
async function getAiActivity(driveId: string, limit = 50) {
  return await db.query.auditEvents.findMany({
    where: and(
      eq(auditEvents.driveId, driveId),
      eq(auditEvents.isAiAction, true)
    ),
    orderBy: [desc(auditEvents.createdAt)],
    limit,
    with: {
      aiOperation: true
    }
  });
}

async function getHumanActivity(driveId: string, limit = 50) {
  return await db.query.auditEvents.findMany({
    where: and(
      eq(auditEvents.driveId, driveId),
      eq(auditEvents.isAiAction, false)
    ),
    orderBy: [desc(auditEvents.createdAt)],
    limit,
    with: {
      user: true
    }
  });
}
```

**Performance**: Uses `isAiAction + createdAt` index

### 9. Grouped Operations

**Use Case**: Show all changes from a single AI operation

```typescript
async function getOperationChanges(operationId: string) {
  return await db.query.auditEvents.findMany({
    where: eq(auditEvents.operationId, operationId),
    orderBy: [asc(auditEvents.createdAt)],
    with: {
      aiOperation: true
    }
  });
}
```

**Performance**: Uses `operationId` index

### 10. Restore Page Version

**Use Case**: Restore a page to a previous version

```typescript
import { pages } from '@pagespace/db';

async function restorePageVersion(
  pageId: string,
  versionNumber: number,
  restoringUserId: string
) {
  // Get the version to restore
  const version = await db.query.pageVersions.findFirst({
    where: and(
      eq(pageVersions.pageId, pageId),
      eq(pageVersions.versionNumber, versionNumber)
    )
  });

  if (!version) {
    throw new Error('Version not found');
  }

  // Get current page state for audit trail
  const currentPage = await db.query.pages.findFirst({
    where: eq(pages.id, pageId)
  });

  // Update the page
  const [updatedPage] = await db
    .update(pages)
    .set({
      content: version.content.content, // Extract from JSONB
      title: version.title,
      updatedAt: new Date()
    })
    .where(eq(pages.id, pageId))
    .returning();

  // Create audit event
  const [auditEvent] = await db.insert(auditEvents).values({
    actionType: 'PAGE_UPDATE',
    entityType: 'PAGE',
    entityId: pageId,
    userId: restoringUserId,
    isAiAction: false,
    driveId: currentPage.driveId,
    beforeState: {
      content: currentPage.content,
      title: currentPage.title
    },
    afterState: {
      content: version.content.content,
      title: version.title
    },
    description: `Restored to version ${versionNumber}`,
    reason: `User restored page to version ${versionNumber}`,
    createdAt: new Date()
  }).returning();

  // Create new version for this restoration
  const maxVersion = await db
    .select({ max: max(pageVersions.versionNumber) })
    .from(pageVersions)
    .where(eq(pageVersions.pageId, pageId));

  await db.insert(pageVersions).values({
    pageId,
    versionNumber: (maxVersion[0].max || 0) + 1,
    content: { content: updatedPage.content },
    title: updatedPage.title,
    pageType: updatedPage.type,
    auditEventId: auditEvent.id,
    createdBy: restoringUserId,
    isAiGenerated: false,
    changeSummary: `Restored to version ${versionNumber}`,
    changeType: 'major',
    createdAt: new Date()
  });

  return updatedPage;
}
```

## Migration Considerations

### Initial Migration

When first deploying this system to production:

1. **Generate the migration**:
   ```bash
   pnpm db:generate
   ```

2. **Review the SQL**: Ensure indexes are created correctly

3. **Consider backfilling**: Decide whether to backfill existing data
   - **Option A**: Start fresh (simpler, recommended)
   - **Option B**: Backfill from existing data (complex)

4. **Test on staging**: Run full migration on staging database

5. **Monitor performance**: Watch query performance after deployment

### Backfilling Strategy (Optional)

If you need to backfill audit events for existing pages:

```typescript
async function backfillPageCreationEvents() {
  const existingPages = await db.query.pages.findMany({
    orderBy: [asc(pages.createdAt)]
  });

  for (const page of existingPages) {
    await db.insert(auditEvents).values({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: page.id,
      userId: null, // Unknown user
      isAiAction: false,
      driveId: page.driveId,
      afterState: {
        title: page.title,
        type: page.type,
        content: page.content
      },
      description: 'Historical page creation (backfilled)',
      createdAt: page.createdAt
    });

    // Create initial version
    await db.insert(pageVersions).values({
      pageId: page.id,
      versionNumber: 1,
      content: { content: page.content },
      title: page.title,
      pageType: page.type,
      isAiGenerated: false,
      changeSummary: 'Initial version (backfilled)',
      changeType: 'major',
      createdAt: page.createdAt
    });
  }
}
```

**Warning**: This can be slow for large datasets. Consider batching.

### Future Migrations

When adding new action types or entity types:

1. **Add to enum**:
   ```typescript
   // In audit.ts
   export const auditActionType = pgEnum('audit_action_type', [
     // ... existing types
     'NEW_ACTION_TYPE', // Add new type
   ]);
   ```

2. **Generate migration**: `pnpm db:generate`

3. **PostgreSQL enum migration**: PostgreSQL requires special handling for enum changes:
   ```sql
   -- Generated migration may need manual adjustment
   ALTER TYPE audit_action_type ADD VALUE 'NEW_ACTION_TYPE';
   ```

## Performance Optimization

### Index Usage

All common query patterns leverage specific indexes:

| Query Pattern | Index Used |
|--------------|------------|
| Drive activity feed | `driveId + createdAt` |
| User timeline | `userId + createdAt` |
| Page history | `entityType + entityId + createdAt` |
| Page versions | `pageId + versionNumber` |
| AI operations | `userId + createdAt`, `driveId + createdAt` |
| AI vs human filter | `isAiAction + createdAt` |
| Operation grouping | `operationId` |

### JSONB Indexing

For advanced querying on JSONB fields, add GIN indexes:

```typescript
// Add to audit_events table definition
metadataGinIdx: index('audit_events_metadata_gin_idx')
  .using('gin', table.metadata)
```

This enables efficient JSONB queries:

```typescript
// Find all page moves to a specific parent
const moves = await db.query.auditEvents.findMany({
  where: and(
    eq(auditEvents.actionType, 'PAGE_MOVE'),
    sql`${auditEvents.afterState}->>'parentId' = ${newParentId}`
  )
});
```

### Archival Strategy

For systems with millions of audit records:

1. **Partition by time**:
   ```sql
   -- Create monthly partitions (advanced PostgreSQL feature)
   CREATE TABLE audit_events_2025_01 PARTITION OF audit_events
     FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
   ```

2. **Archive old records**:
   - Move records older than N months to archive table
   - Keep indexes on archive table
   - Use UNION queries to search both current and archive

3. **Retention policy**:
   - Keep detailed audit events for 12 months
   - Aggregate to daily summaries after 12 months
   - Retain page versions indefinitely (or user-configurable)

## Integration Points

### 1. Create Audit Event (Utility Function)

```typescript
// lib/audit/create-audit-event.ts
import { db, auditEvents, auditActionType, auditEntityType } from '@pagespace/db';

export async function createAuditEvent({
  actionType,
  entityType,
  entityId,
  userId,
  driveId,
  beforeState,
  afterState,
  changes,
  description,
  reason,
  isAiAction = false,
  aiOperationId,
  operationId,
  requestId,
  sessionId,
  ipAddress,
  userAgent,
  metadata
}: {
  actionType: typeof auditActionType.enumValues[number];
  entityType: typeof auditEntityType.enumValues[number];
  entityId: string;
  userId?: string;
  driveId?: string;
  beforeState?: any;
  afterState?: any;
  changes?: any;
  description?: string;
  reason?: string;
  isAiAction?: boolean;
  aiOperationId?: string;
  operationId?: string;
  requestId?: string;
  sessionId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: any;
}) {
  return await db.insert(auditEvents).values({
    actionType,
    entityType,
    entityId,
    userId,
    driveId,
    beforeState,
    afterState,
    changes,
    description,
    reason,
    isAiAction,
    aiOperationId,
    operationId,
    requestId,
    sessionId,
    ipAddress,
    userAgent,
    metadata,
    createdAt: new Date()
  }).returning();
}
```

### 2. Create Page Version (Utility Function)

```typescript
// lib/audit/create-page-version.ts
import { db, pageVersions, pages, eq, max } from '@pagespace/db';

export async function createPageVersion({
  pageId,
  auditEventId,
  userId,
  isAiGenerated = false,
  changeSummary,
  changeType = 'minor'
}: {
  pageId: string;
  auditEventId?: string;
  userId?: string;
  isAiGenerated?: boolean;
  changeSummary?: string;
  changeType?: 'minor' | 'major' | 'ai_edit' | 'user_edit';
}) {
  // Get current page state
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, pageId)
  });

  if (!page) {
    throw new Error('Page not found');
  }

  // Get next version number
  const maxVersion = await db
    .select({ max: max(pageVersions.versionNumber) })
    .from(pageVersions)
    .where(eq(pageVersions.pageId, pageId));

  const nextVersion = (maxVersion[0].max || 0) + 1;

  // Create version
  return await db.insert(pageVersions).values({
    pageId,
    versionNumber: nextVersion,
    content: {
      content: page.content,
      // Include other content fields if needed
    },
    title: page.title,
    pageType: page.type,
    metadata: {
      aiProvider: page.aiProvider,
      aiModel: page.aiModel,
      systemPrompt: page.systemPrompt,
      enabledTools: page.enabledTools
    },
    auditEventId,
    createdBy: userId,
    isAiGenerated,
    contentSize: Buffer.byteLength(page.content, 'utf8'),
    changeSummary,
    changeType,
    createdAt: new Date()
  }).returning();
}
```

### 3. Track AI Operation (Utility Function)

```typescript
// lib/audit/track-ai-operation.ts
import { db, aiOperations, aiAgentType } from '@pagespace/db';

export async function trackAiOperation({
  userId,
  agentType,
  provider,
  model,
  operationType,
  prompt,
  systemPrompt,
  conversationId,
  messageId,
  driveId,
  pageId,
  toolsCalled,
  toolResults
}: {
  userId: string;
  agentType: typeof aiAgentType.enumValues[number];
  provider: string;
  model: string;
  operationType: string;
  prompt?: string;
  systemPrompt?: string;
  conversationId?: string;
  messageId?: string;
  driveId?: string;
  pageId?: string;
  toolsCalled?: any;
  toolResults?: any;
}) {
  const [operation] = await db.insert(aiOperations).values({
    userId,
    agentType,
    provider,
    model,
    operationType,
    prompt,
    systemPrompt,
    conversationId,
    messageId,
    driveId,
    pageId,
    toolsCalled,
    toolResults,
    status: 'in_progress',
    createdAt: new Date()
  }).returning();

  return {
    id: operation.id,
    // Helper to update operation on completion
    complete: async (completion: string, actionsPerformed: any, tokens: { input: number, output: number, cost: number }) => {
      await db.update(aiOperations)
        .set({
          completion,
          actionsPerformed,
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          totalCost: tokens.cost,
          status: 'completed',
          completedAt: new Date(),
          duration: Date.now() - operation.createdAt.getTime()
        })
        .where(eq(aiOperations.id, operation.id));
    },
    // Helper to mark operation as failed
    fail: async (error: string) => {
      await db.update(aiOperations)
        .set({
          error,
          status: 'failed',
          completedAt: new Date(),
          duration: Date.now() - operation.createdAt.getTime()
        })
        .where(eq(aiOperations.id, operation.id));
    }
  };
}
```

### 4. Integration Example: Page Update

```typescript
// Example: Updating a page with full audit trail
async function updatePageWithAudit(
  pageId: string,
  updates: { content?: string; title?: string },
  context: {
    userId?: string;
    isAiAction?: boolean;
    aiOperationId?: string;
    reason?: string;
    requestId?: string;
  }
) {
  // Get current state
  const beforeState = await db.query.pages.findFirst({
    where: eq(pages.id, pageId)
  });

  if (!beforeState) {
    throw new Error('Page not found');
  }

  // Update page
  const [afterState] = await db
    .update(pages)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(pages.id, pageId))
    .returning();

  // Compute changes
  const changes = {};
  if (updates.content && updates.content !== beforeState.content) {
    changes.content = { before: beforeState.content, after: updates.content };
  }
  if (updates.title && updates.title !== beforeState.title) {
    changes.title = { before: beforeState.title, after: updates.title };
  }

  // Create audit event
  const [auditEvent] = await createAuditEvent({
    actionType: 'PAGE_UPDATE',
    entityType: 'PAGE',
    entityId: pageId,
    userId: context.userId,
    driveId: beforeState.driveId,
    isAiAction: context.isAiAction || false,
    aiOperationId: context.aiOperationId,
    beforeState: {
      content: beforeState.content,
      title: beforeState.title
    },
    afterState: {
      content: afterState.content,
      title: afterState.title
    },
    changes,
    description: `Updated page "${beforeState.title}"`,
    reason: context.reason,
    requestId: context.requestId
  });

  // Create version snapshot (only if content changed)
  if (updates.content && updates.content !== beforeState.content) {
    await createPageVersion({
      pageId,
      auditEventId: auditEvent.id,
      userId: context.userId,
      isAiGenerated: context.isAiAction || false,
      changeSummary: context.reason || 'Content updated',
      changeType: context.isAiAction ? 'ai_edit' : 'user_edit'
    });
  }

  return afterState;
}
```

## Security Considerations

### Drive-Scoped Access

Always filter audit events by drives the user has access to:

```typescript
async function getUserAccessibleDrives(userId: string): Promise<string[]> {
  // Get drives user owns or is a member of
  // Implementation depends on your permission system
}

async function getAuditEventsForUser(userId: string) {
  const accessibleDrives = await getUserAccessibleDrives(userId);

  return await db.query.auditEvents.findMany({
    where: inArray(auditEvents.driveId, accessibleDrives),
    orderBy: [desc(auditEvents.createdAt)],
    limit: 100
  });
}
```

### Sensitive Data

Be careful what goes into JSONB fields:
- **Do NOT store**: Passwords, API keys, tokens
- **Safe to store**: UI state, public metadata, change descriptions

### Admin-Only Fields

Certain fields should only be visible to admins:
- IP addresses
- User agents
- Error stack traces

## Testing Strategy

### Unit Tests

Test audit event creation:

```typescript
describe('Audit Trail', () => {
  it('should create audit event for page update', async () => {
    const event = await createAuditEvent({
      actionType: 'PAGE_UPDATE',
      entityType: 'PAGE',
      entityId: 'page123',
      userId: 'user123',
      driveId: 'drive123',
      description: 'Updated page content'
    });

    expect(event.actionType).toBe('PAGE_UPDATE');
    expect(event.entityId).toBe('page123');
  });
});
```

### Integration Tests

Test full workflows:

```typescript
describe('Page Versioning', () => {
  it('should create version on content update', async () => {
    const page = await createTestPage();

    await updatePageWithAudit(page.id, {
      content: 'Updated content'
    }, {
      userId: 'user123',
      reason: 'Fixed typo'
    });

    const versions = await getPageVersions(page.id);
    expect(versions).toHaveLength(2); // Initial + update
    expect(versions[0].versionNumber).toBe(2);
  });
});
```

### Performance Tests

Test query performance:

```typescript
describe('Audit Query Performance', () => {
  it('should query drive activity efficiently', async () => {
    // Create 10,000 audit events
    await createManyAuditEvents(10000);

    const start = Date.now();
    const activity = await getDriveActivity('drive123', 50);
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(100); // Should be <100ms
    expect(activity).toHaveLength(50);
  });
});
```

## Future Enhancements

### 1. Undo/Redo

The audit trail provides everything needed for undo/redo:
- `beforeState` contains previous state
- `afterState` contains current state
- Can create "undo" audit event that reverses the change

### 2. Real-time Activity Feed

Use PostgreSQL LISTEN/NOTIFY:

```sql
CREATE OR REPLACE FUNCTION notify_audit_event()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('audit_events', json_build_object(
    'driveId', NEW.drive_id,
    'actionType', NEW.action_type,
    'entityType', NEW.entity_type
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_notify
AFTER INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION notify_audit_event();
```

### 3. Advanced Diff Viewing

Generate diffs on-the-fly from full snapshots:
- Use libraries like `diff-match-patch`
- Compute diffs in API layer, not database
- Cache frequently accessed diffs

### 4. Audit Reports

Pre-computed reports:
- Daily/weekly/monthly activity summaries
- AI vs human contribution metrics
- Most active users/pages
- Storage growth analysis

### 5. Compliance Export

Export audit trail for compliance:
- Generate CSV/JSON exports
- Include all relevant fields
- Sign exports with checksums

## Summary

The PageSpace audit trail and versioning system provides:

- **Comprehensive tracking**: Every action logged with full context
- **Content versioning**: Full snapshots for reliable history
- **AI attribution**: Complete chain from prompt to change
- **Security**: Drive-scoped access control
- **Performance**: Strategic indexes for common queries
- **Flexibility**: JSONB for evolving requirements
- **Compliance**: Immutable audit trail for regulatory needs

The system is designed for scale, supporting millions of audit events while maintaining query performance through careful indexing and partitioning strategies.
