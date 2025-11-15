# Audit Trail Schema - Quick Reference

## Tables

### audit_events
Master log of all actions in PageSpace.

**Primary Key**: `id` (CUID2)
**Foreign Keys**:
- `userId` → users.id (SET NULL)
- `driveId` → drives.id (CASCADE)
- `aiOperationId` → ai_operations.id

**Key Columns**:
- `actionType`: What happened (enum)
- `entityType`: What was affected (enum)
- `entityId`: Which entity
- `beforeState`, `afterState`: JSONB snapshots
- `changes`: Computed diff (JSONB)
- `operationId`: Group related changes

**Indexes**: 9 strategic indexes for performance

### page_versions
Historical snapshots of page content.

**Primary Key**: `id` (CUID2)
**Foreign Keys**:
- `pageId` → pages.id (CASCADE)
- `auditEventId` → audit_events.id (SET NULL)
- `createdBy` → users.id (SET NULL)

**Key Columns**:
- `versionNumber`: Sequential (1, 2, 3...)
- `content`: Full snapshot (JSONB)
- `title`, `pageType`: Metadata
- `isAiGenerated`: AI vs human

**Indexes**: 6 indexes for version lookups

### ai_operations
AI operation tracking with full context.

**Primary Key**: `id` (CUID2)
**Foreign Keys**:
- `userId` → users.id (CASCADE)
- `driveId` → drives.id (CASCADE)
- `pageId` → pages.id (SET NULL)

**Key Columns**:
- `agentType`: AI agent type (enum)
- `provider`, `model`: AI model info
- `prompt`: Original prompt
- `toolsCalled`: Tools used (JSONB)
- `inputTokens`, `outputTokens`, `totalCost`: Usage

**Indexes**: 9 indexes for usage analysis

## Enums

### auditActionType (26 values)
PAGE_CREATE, PAGE_UPDATE, PAGE_DELETE, PAGE_RESTORE, PAGE_MOVE, PAGE_RENAME, PAGE_DUPLICATE,
PERMISSION_GRANT, PERMISSION_REVOKE, PERMISSION_UPDATE,
DRIVE_CREATE, DRIVE_UPDATE, DRIVE_DELETE, DRIVE_RESTORE,
MEMBER_ADD, MEMBER_REMOVE, MEMBER_UPDATE_ROLE,
FILE_UPLOAD, FILE_DELETE, FILE_UPDATE,
MESSAGE_CREATE, MESSAGE_UPDATE, MESSAGE_DELETE,
AI_EDIT, AI_GENERATE, AI_TOOL_CALL, AI_CONVERSATION,
SETTINGS_UPDATE, EXPORT, IMPORT

### auditEntityType (8 values)
PAGE, DRIVE, PERMISSION, MEMBER, FILE, MESSAGE, SETTINGS, AI_OPERATION

### aiAgentType (8 values)
ASSISTANT, EDITOR, RESEARCHER, CODER, ANALYST, WRITER, REVIEWER, CUSTOM

## Quick Usage

```typescript
// Create audit event
import { createAuditEvent } from '@pagespace/lib/audit';

await createAuditEvent({
  actionType: 'PAGE_UPDATE',
  entityType: 'PAGE',
  entityId: pageId,
  userId: userId,
  driveId: driveId,
  beforeState: { content: oldContent },
  afterState: { content: newContent },
  description: 'Updated page'
});

// Create page version
import { createPageVersion } from '@pagespace/lib/audit';

await createPageVersion({
  pageId,
  userId,
  changeSummary: 'User edit',
  changeType: 'user_edit'
});

// Track AI operation
import { trackAiOperation } from '@pagespace/lib/audit';

const op = await trackAiOperation({
  userId, agentType: 'EDITOR',
  provider: 'openai', model: 'gpt-4',
  operationType: 'edit'
});

await op.complete({
  completion: result,
  actionsPerformed: {},
  tokens: { input: 100, output: 200, cost: 50 }
});

// Query activity
import { getDriveActivityFeed } from '@pagespace/lib/audit';

const activity = await getDriveActivityFeed(driveId, 50);
```

## Documentation

- Full docs: `/docs/3.0-guides-and-tools/audit-trail-and-versioning.md`
- Examples: `/docs/3.0-guides-and-tools/audit-integration-examples.md`
- Migration: `/docs/3.0-guides-and-tools/audit-migration-guide.md`
- Summary: `/AUDIT_TRAIL_SCHEMA_SUMMARY.md`
