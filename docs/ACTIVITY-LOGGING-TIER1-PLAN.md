# Activity Logging: Tier 1 Implementation Plan

**Goal:** Complete the user-facing activity monitor (like Google Drive) for rollback and change visibility.

---

## Gaps to Fix

### 1. Message Editing/Deletion in Shared Chats (HIGH)

Users can edit or delete messages in shared AI chats, which rewrites history for other participants.

| Operation | Route | What to Log |
|-----------|-------|-------------|
| Edit message | `/api/ai/chat/messages/[messageId]` PATCH | Previous content, new content |
| Delete message | `/api/ai/chat/messages/[messageId]` DELETE | Deleted content (for audit) |
| Edit global message | `/api/ai/global/[id]/messages/[messageId]` PATCH | Previous content, new content |
| Delete global message | `/api/ai/global/[id]/messages/[messageId]` DELETE | Deleted content |

### 2. Agent Config Changes via API (HIGH)

The AI tool version already logs properly. The API routes need to match.

| Operation | Route | What to Log |
|-----------|-------|-------------|
| Update agent config | `/api/ai/page-agents/[agentId]/config` PATCH | System prompt, tools, visibility changes |
| Update page agent | `/api/pages/[pageId]/agent-config` PATCH | Same as above |

### 3. Role Reordering (MEDIUM)

| Operation | Route | What to Log |
|-----------|-------|-------------|
| Reorder roles | `/api/drives/[driveId]/roles/reorder` PATCH | Previous order, new order |

### 4. Drive Ownership Transfer (MEDIUM)

| Operation | Route | What to Log |
|-----------|-------|-------------|
| Transfer ownership | `/api/account/handle-drive` POST | Previous owner, new owner |

### 5. ask_agent Chain Tracking (MEDIUM)

When a sub-agent makes changes, we need to know which parent agent initiated it.

| Gap | Location | What to Add |
|-----|----------|-------------|
| Chain context | `agent-communication-tools.ts` | `parentAgentId`, `initiatingConversationId` in metadata |

---

## Schema Changes

Add to `packages/db/src/schema/monitoring.ts`:

```typescript
// Add to activityOperationEnum array:
'message_update',
'message_delete',
'role_reorder',
'ownership_transfer',

// Add to activityResourceEnum array:
'message',
```

---

## New Logging Function

Add to `packages/lib/src/monitoring/activity-logger.ts`:

```typescript
export function logMessageActivity(
  userId: string,
  operation: 'message_update' | 'message_delete',
  message: {
    id: string;
    pageId: string;
    conversationType: 'ai_chat' | 'global' | 'channel';
  },
  actorInfo: ActorInfo,
  options?: {
    previousContent?: string;
    newContent?: string;
    isAiGenerated?: boolean;
    aiProvider?: string;
    aiModel?: string;
    aiConversationId?: string;
  }
): void {
  logActivity({
    userId,
    actorEmail: actorInfo.actorEmail,
    actorDisplayName: actorInfo.actorDisplayName,
    operation,
    resourceType: 'message',
    resourceId: message.id,
    pageId: message.pageId,
    previousValues: options?.previousContent ? { content: options.previousContent } : undefined,
    newValues: options?.newContent ? { content: options.newContent } : undefined,
    metadata: {
      conversationType: message.conversationType,
    },
    isAiGenerated: options?.isAiGenerated ?? false,
    aiProvider: options?.aiProvider,
    aiModel: options?.aiModel,
    aiConversationId: options?.aiConversationId,
  });
}
```

---

## Implementation Tasks

### Task 1: Schema Migration
**File:** `packages/db/src/schema/monitoring.ts`

Add the new enum values and run migration.

### Task 2: Add logMessageActivity Function
**File:** `packages/lib/src/monitoring/activity-logger.ts`

Add the function above.

### Task 3: AI Chat Message Routes
**File:** `apps/web/src/app/api/ai/chat/messages/[messageId]/route.ts`

```typescript
// In PATCH handler, after updating:
const actorInfo = await getActorInfo(userId);
logMessageActivity(userId, 'message_update', {
  id: messageId,
  pageId: message.pageId,
  conversationType: 'ai_chat',
}, actorInfo, {
  previousContent: originalContent,
  newContent: newContent,
});

// In DELETE handler, after deleting:
logMessageActivity(userId, 'message_delete', {
  id: messageId,
  pageId: message.pageId,
  conversationType: 'ai_chat',
}, actorInfo, {
  previousContent: deletedContent,
});
```

### Task 4: Global AI Message Routes
**File:** `apps/web/src/app/api/ai/global/[id]/messages/[messageId]/route.ts`

Same pattern as Task 3, but with `conversationType: 'global'`.

### Task 5: Agent Config API Route
**File:** `apps/web/src/app/api/ai/page-agents/[agentId]/config/route.ts`

```typescript
// After updating config:
const actorInfo = await getActorInfo(userId);
logAgentConfigActivity(userId, {
  id: agentId,
  title: agent.title,
  pageId: agent.pageId,
}, {
  updatedFields: Object.keys(updates),
  previousValues: originalConfig,
  newValues: updates,
}, actorInfo);
```

### Task 6: Page Agent Config Route
**File:** `apps/web/src/app/api/pages/[pageId]/agent-config/route.ts`

Same pattern as Task 5.

### Task 7: Role Reorder Route
**File:** `apps/web/src/app/api/drives/[driveId]/roles/reorder/route.ts`

```typescript
// After reordering:
const actorInfo = await getActorInfo(userId);
logRoleActivity(userId, 'role_reorder', {
  driveId,
  driveName: access.drive.name,
  previousOrder: previousRoleIds,
  newOrder: roleIds,
}, actorInfo);
```

Note: May need to add `role_reorder` operation support to `logRoleActivity` or use generic `logActivity`.

### Task 8: Ownership Transfer Route
**File:** `apps/web/src/app/api/account/handle-drive/route.ts`

```typescript
// After transfer:
const actorInfo = await getActorInfo(userId);
logDriveActivity(userId, 'ownership_transfer', {
  id: driveId,
  name: drive.name,
}, actorInfo, {
  previousValues: { ownerId: previousOwnerId },
  newValues: { ownerId: newOwnerId },
});
```

Note: May need to add `ownership_transfer` to drive operations.

### Task 9: ask_agent Chain Context
**File:** `apps/web/src/lib/ai/tools/agent-communication-tools.ts`

When sub-agent executes tools, pass parent context:

```typescript
// In the tool execution context, include:
metadata: {
  parentAgentId: callingAgentId,
  parentConversationId: callingConversationId,
  agentChain: [...parentChain, currentAgentId],
}
```

---

## Testing Checklist

- [ ] Edit AI chat message shows in activity log with previous/new content
- [ ] Delete AI chat message shows in activity log
- [ ] Edit global assistant message shows in activity log
- [ ] Delete global assistant message shows in activity log
- [ ] Agent config change via API shows in activity log
- [ ] Role reorder shows in activity log with order change
- [ ] Drive ownership transfer shows in activity log
- [ ] Sub-agent changes include parent agent context in metadata
- [ ] Activity retrieval API (`GET /api/activities`) returns new operation types
- [ ] Filtering by `resourceType: 'message'` works

---

## Files Summary

| File | Change |
|------|--------|
| `packages/db/src/schema/monitoring.ts` | Add enum values |
| `packages/lib/src/monitoring/activity-logger.ts` | Add `logMessageActivity` |
| `apps/web/src/app/api/ai/chat/messages/[messageId]/route.ts` | Add logging |
| `apps/web/src/app/api/ai/global/[id]/messages/[messageId]/route.ts` | Add logging |
| `apps/web/src/app/api/ai/page-agents/[agentId]/config/route.ts` | Add logging |
| `apps/web/src/app/api/pages/[pageId]/agent-config/route.ts` | Add logging |
| `apps/web/src/app/api/drives/[driveId]/roles/reorder/route.ts` | Add logging |
| `apps/web/src/app/api/account/handle-drive/route.ts` | Add logging |
| `apps/web/src/lib/ai/tools/agent-communication-tools.ts` | Add chain context |
