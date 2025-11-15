# AI Audit Tracking - Practical Examples

This document provides practical examples of using PageSpace's AI audit tracking system.

## Example 1: Querying "What Did This AI Message Change?"

Build a UI that shows users exactly what an AI message modified:

```typescript
import { db, aiOperations, eq } from '@pagespace/db';
import { getOperationEvents } from '@pagespace/lib/audit';

async function getAiMessageChanges(messageId: string) {
  // 1. Find the AI operation for this message
  const [operation] = await db.query.aiOperations.findMany({
    where: eq(aiOperations.messageId, messageId),
    limit: 1,
    with: {
      user: {
        columns: { id: true, name: true, image: true }
      }
    }
  });

  if (!operation) {
    return null;
  }

  // 2. Get all audit events linked to this operation
  const events = await getOperationEvents(operation.id);

  // 3. Format for display
  return {
    operation: {
      id: operation.id,
      prompt: operation.prompt,
      model: operation.model,
      provider: operation.provider,
      toolsUsed: operation.actionsPerformed?.toolsUsed || [],
      tokensUsed: operation.inputTokens + operation.outputTokens,
      duration: operation.duration,
    },
    changes: events.map(event => ({
      action: event.actionType,
      entity: event.entityType,
      entityId: event.entityId,
      description: event.description,
      before: event.beforeState,
      after: event.afterState,
      changes: event.changes,
      timestamp: event.createdAt,
    })),
    summary: buildChangeSummary(events),
  };
}

function buildChangeSummary(events: AuditEvent[]) {
  const summary = {
    pagesCreated: 0,
    pagesUpdated: 0,
    pagesDeleted: 0,
    pagesMoved: 0,
  };

  events.forEach(event => {
    switch (event.actionType) {
      case 'PAGE_CREATE': summary.pagesCreated++; break;
      case 'PAGE_UPDATE': summary.pagesUpdated++; break;
      case 'PAGE_DELETE': summary.pagesDeleted++; break;
      case 'PAGE_MOVE': summary.pagesMoved++; break;
    }
  });

  return summary;
}
```

### UI Display Example

```tsx
function AiMessageChangesPanel({ messageId }: { messageId: string }) {
  const { data, loading } = useSWR(
    `/api/ai/messages/${messageId}/changes`,
    fetcher
  );

  if (loading) return <Spinner />;
  if (!data?.changes?.length) return null;

  return (
    <div className="mt-4 rounded-lg border bg-muted/50 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="h-4 w-4 text-primary" />
        <h4 className="font-semibold">Changes Made by AI</h4>
      </div>

      <div className="space-y-2 text-sm">
        {data.summary.pagesCreated > 0 && (
          <div>✨ Created {data.summary.pagesCreated} page(s)</div>
        )}
        {data.summary.pagesUpdated > 0 && (
          <div>📝 Updated {data.summary.pagesUpdated} page(s)</div>
        )}
        {data.summary.pagesMoved > 0 && (
          <div>📦 Moved {data.summary.pagesMoved} page(s)</div>
        )}
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          View detailed changes
        </summary>
        <div className="mt-2 space-y-2">
          {data.changes.map((change, i) => (
            <div key={i} className="border-l-2 pl-3 py-1">
              <div className="font-medium">{change.action}</div>
              <div className="text-xs text-muted-foreground">
                {change.description}
              </div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
```

## Example 2: Building an AI Activity Feed

Show recent AI operations in a drive:

```typescript
import { getDriveAiActivity } from '@pagespace/lib/audit';

async function getAiActivityFeed(driveId: string, limit = 20) {
  const activities = await getDriveAiActivity(driveId, limit);

  return activities.map(activity => ({
    id: activity.id,
    user: {
      name: activity.user.name,
      image: activity.user.image,
    },
    action: activity.actionType,
    description: formatActivityDescription(activity),
    timestamp: activity.createdAt,
    aiOperation: activity.aiOperation ? {
      model: activity.aiOperation.model,
      prompt: activity.aiOperation.prompt?.substring(0, 100) + '...',
    } : null,
  }));
}

function formatActivityDescription(activity: AuditEvent) {
  const aiPrefix = activity.isAiAction ? '🤖 AI ' : '';

  switch (activity.actionType) {
    case 'PAGE_CREATE':
      return `${aiPrefix}created page "${activity.afterState?.title}"`;
    case 'PAGE_UPDATE':
      return `${aiPrefix}updated page "${activity.afterState?.title}"`;
    case 'PAGE_DELETE':
      return `${aiPrefix}deleted page "${activity.beforeState?.title}"`;
    case 'PAGE_MOVE':
      return `${aiPrefix}moved page "${activity.afterState?.title}"`;
    default:
      return `${aiPrefix}performed ${activity.actionType}`;
  }
}
```

### UI Component

```tsx
function AiActivityFeed({ driveId }: { driveId: string }) {
  const { data } = useSWR(`/api/drives/${driveId}/ai-activity`, fetcher);

  return (
    <div className="space-y-3">
      <h3 className="font-semibold">Recent AI Activity</h3>
      <div className="space-y-2">
        {data?.map((activity) => (
          <div key={activity.id} className="flex gap-3 p-3 rounded-lg border">
            <Avatar src={activity.user.image} name={activity.user.name} />
            <div className="flex-1 min-w-0">
              <p className="text-sm">
                <span className="font-medium">{activity.user.name}</span>
                {' '}
                {activity.description}
              </p>
              {activity.aiOperation && (
                <p className="text-xs text-muted-foreground mt-1">
                  Prompt: "{activity.aiOperation.prompt}"
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                {formatDistanceToNow(activity.timestamp)} ago
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

## Example 3: AI Usage Dashboard

Build a dashboard showing AI usage statistics:

```typescript
import {
  getAiUsageSummary,
  getAiUsageReport,
  getUserAiOperations
} from '@pagespace/lib/audit';

async function getAiUsageDashboard(userId: string) {
  const [summary, report, recentOps] = await Promise.all([
    getAiUsageSummary(userId, 30), // Last 30 days
    getAiUsageReport(userId,
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      new Date()
    ),
    getUserAiOperations(userId, 10),
  ]);

  return {
    summary: {
      totalCalls: summary.total,
      successRate: summary.successRate,
      totalTokens: summary.totalTokens,
      totalCost: summary.totalCostDollars,
      avgDuration: summary.avgDuration,
    },
    breakdown: report.map(r => ({
      provider: r.provider,
      model: r.model,
      operations: r.operationCount,
      tokens: Number(r.totalInputTokens) + Number(r.totalOutputTokens),
      cost: Number(r.totalCost) / 100,
    })),
    recent: recentOps.map(op => ({
      id: op.id,
      prompt: op.prompt?.substring(0, 100),
      model: `${op.provider}/${op.model}`,
      status: op.status,
      duration: op.duration,
      tokens: (op.inputTokens || 0) + (op.outputTokens || 0),
      createdAt: op.createdAt,
    })),
  };
}
```

## Example 4: Implementing Undo for AI Operations

Future implementation showing how to undo AI changes:

```typescript
async function undoAiOperation(operationId: string, userId: string) {
  // 1. Get the AI operation
  const [operation] = await db.query.aiOperations.findMany({
    where: eq(aiOperations.id, operationId),
    limit: 1,
  });

  if (!operation) {
    throw new Error('AI operation not found');
  }

  // 2. Verify user owns this operation
  if (operation.userId !== userId) {
    throw new Error('Unauthorized');
  }

  // 3. Get all audit events for this operation
  const events = await getOperationEvents(operationId);

  // 4. Reverse changes in reverse chronological order
  const reversedEvents = [...events].reverse();
  const results = [];

  for (const event of reversedEvents) {
    try {
      switch (event.actionType) {
        case 'PAGE_CREATE':
          // Delete the created page
          await db.update(pages)
            .set({ isTrashed: true })
            .where(eq(pages.id, event.entityId));
          results.push({
            action: 'DELETED',
            entityId: event.entityId
          });
          break;

        case 'PAGE_UPDATE':
          // Restore previous content
          if (event.beforeState) {
            await db.update(pages)
              .set({
                content: event.beforeState.content,
                title: event.beforeState.title,
                updatedAt: new Date(),
              })
              .where(eq(pages.id, event.entityId));
            results.push({
              action: 'RESTORED',
              entityId: event.entityId
            });
          }
          break;

        case 'PAGE_MOVE':
          // Move back to original location
          if (event.beforeState) {
            await db.update(pages)
              .set({
                parentId: event.beforeState.parentId,
                order: event.beforeState.order,
              })
              .where(eq(pages.id, event.entityId));
            results.push({
              action: 'MOVED_BACK',
              entityId: event.entityId
            });
          }
          break;
      }
    } catch (error) {
      results.push({
        action: 'FAILED',
        entityId: event.entityId,
        error: error.message
      });
    }
  }

  // 5. Mark operation as cancelled
  await db.update(aiOperations)
    .set({ status: 'cancelled' })
    .where(eq(aiOperations.id, operationId));

  return {
    success: true,
    operationId,
    reversedEvents: results.length,
    details: results,
  };
}
```

## Example 5: Comparing AI Model Performance

Analyze which AI models perform best:

```typescript
async function compareAiModelPerformance(userId: string, days = 30) {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const report = await getAiUsageReport(userId, startDate, new Date());

  return report.map(r => ({
    model: `${r.provider}/${r.model}`,
    operations: r.operationCount,
    avgDuration: Number(r.avgDuration) || 0,
    avgTokensPerOp:
      (Number(r.totalInputTokens) + Number(r.totalOutputTokens)) /
      r.operationCount,
    costPerOp: Number(r.totalCost) / r.operationCount / 100,
    efficiency: calculateEfficiency(r),
  })).sort((a, b) => b.efficiency - a.efficiency);
}

function calculateEfficiency(report: any) {
  // Efficiency = operations per dollar
  const totalCost = Number(report.totalCost) / 100;
  return totalCost > 0 ? report.operationCount / totalCost : 0;
}
```

## Example 6: AI Operation Health Monitoring

Monitor AI operation success rates and identify issues:

```typescript
async function monitorAiOperationHealth(userId?: string) {
  const failedOps = await getFailedAiOperations(userId, 50);

  const errorsByModel = new Map<string, number>();
  const errorsByType = new Map<string, number>();
  const commonErrors = new Map<string, number>();

  failedOps.forEach(op => {
    const modelKey = `${op.provider}/${op.model}`;
    errorsByModel.set(modelKey, (errorsByModel.get(modelKey) || 0) + 1);
    errorsByType.set(op.operationType, (errorsByType.get(op.operationType) || 0) + 1);

    if (op.error) {
      commonErrors.set(op.error, (commonErrors.get(op.error) || 0) + 1);
    }
  });

  return {
    totalFailures: failedOps.length,
    errorsByModel: Array.from(errorsByModel.entries())
      .map(([model, count]) => ({ model, count }))
      .sort((a, b) => b.count - a.count),
    errorsByType: Array.from(errorsByType.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    topErrors: Array.from(commonErrors.entries())
      .map(([error, count]) => ({ error, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
  };
}
```

## API Route Examples

### Get AI message changes

```typescript
// /api/ai/messages/[messageId]/changes/route.ts
import { NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { db, aiOperations, eq } from '@pagespace/db';
import { getOperationEvents } from '@pagespace/lib/audit';

export async function GET(
  request: Request,
  context: { params: Promise<{ messageId: string }> }
) {
  const auth = await authenticateRequest(request);
  if (!auth.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { messageId } = await context.params;

  // Get AI operation
  const [operation] = await db.query.aiOperations.findMany({
    where: eq(aiOperations.messageId, messageId),
    limit: 1,
  });

  if (!operation) {
    return NextResponse.json({ changes: [] });
  }

  // Verify user owns this operation
  if (operation.userId !== auth.userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Get changes
  const events = await getOperationEvents(operation.id);

  return NextResponse.json({
    operation: {
      id: operation.id,
      model: operation.model,
      prompt: operation.prompt,
      toolsUsed: operation.actionsPerformed?.toolsUsed || [],
    },
    changes: events,
  });
}
```

### Get drive AI activity

```typescript
// /api/drives/[driveId]/ai-activity/route.ts
import { NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { getDriveAiActivity } from '@pagespace/lib/audit';
import { canUserViewDrive } from '@pagespace/lib/server';

export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  const auth = await authenticateRequest(request);
  if (!auth.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { driveId } = await context.params;

  // Check permissions
  const canView = await canUserViewDrive(auth.userId, driveId);
  if (!canView) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const activities = await getDriveAiActivity(driveId, 20);

  return NextResponse.json(activities);
}
```

## Testing Examples

```typescript
describe('AI Audit Tracking', () => {
  it('should track AI operation from start to finish', async () => {
    const operation = await trackAiOperation({
      userId: 'user123',
      agentType: 'ASSISTANT',
      provider: 'openai',
      model: 'gpt-4',
      operationType: 'conversation',
      prompt: 'Create a project plan',
    });

    expect(operation.id).toBeDefined();

    await operation.complete({
      completion: 'Created project plan',
      actionsPerformed: { pagesCreated: 1 },
      tokens: { input: 100, output: 200, cost: 50 },
    });

    const [saved] = await db.query.aiOperations.findMany({
      where: eq(aiOperations.id, operation.id),
      limit: 1,
    });

    expect(saved.status).toBe('completed');
    expect(saved.inputTokens).toBe(100);
  });

  it('should link audit events to AI operation', async () => {
    const operation = await trackAiOperation({ /* ... */ });

    await createAuditEvent({
      actionType: 'PAGE_CREATE',
      entityType: 'PAGE',
      entityId: 'page123',
      userId: 'user123',
      isAiAction: true,
      aiOperationId: operation.id,
    });

    const events = await getOperationEvents(operation.id);
    expect(events).toHaveLength(1);
    expect(events[0].aiOperationId).toBe(operation.id);
  });
});
```
