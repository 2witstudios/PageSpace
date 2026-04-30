import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { canUserEditPage } from '@pagespace/lib/permissions/permissions';
import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { taskItems, taskLists } from '@pagespace/db/schema/tasks';
import { workflows } from '@pagespace/db/schema/workflows';
import { broadcastTaskEvent } from '@/lib/websocket';

const SESSION_WRITE = { allow: ['session'] as const, requireCSRF: true };

const triggerTypeParam = z.enum(['due_date', 'completion']);

// DELETE /api/tasks/[taskId]/triggers/[triggerType] — disable one specific trigger
export async function DELETE(
  request: Request,
  context: { params: Promise<{ taskId: string; triggerType: string }> },
) {
  const auth = await authenticateRequestWithOptions(request, SESSION_WRITE);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const { taskId, triggerType } = await context.params;

  const parsedType = triggerTypeParam.safeParse(triggerType);
  if (!parsedType.success) {
    return NextResponse.json({ error: 'Invalid trigger type' }, { status: 400 });
  }
  const triggerTypeDb = parsedType.data === 'completion' ? 'task_completion' as const : 'task_due_date' as const;

  const task = await db.query.taskItems.findFirst({ where: eq(taskItems.id, taskId) });
  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  const taskList = await db.query.taskLists.findFirst({ where: eq(taskLists.id, task.taskListId) });
  if (!taskList?.pageId) {
    return NextResponse.json({ error: 'Task list not found' }, { status: 404 });
  }

  const page = await db.query.pages.findFirst({
    where: eq(pages.id, taskList.pageId),
    columns: { id: true, isTrashed: true },
  });
  if (!page || page.isTrashed) {
    return NextResponse.json({ error: 'Task list page not found' }, { status: 404 });
  }

  const canEdit = await canUserEditPage(userId, taskList.pageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await db
    .update(workflows)
    .set({ isEnabled: false, lastRunError: 'Disabled by user', nextRunAt: null })
    .where(and(eq(workflows.taskItemId, taskId), eq(workflows.triggerType, triggerTypeDb)));

  // Refresh metadata.triggerTypes — drop the disabled type
  const existingTypes = ((task.metadata as Record<string, unknown> | null)?.triggerTypes as string[] | undefined) ?? [];
  const remaining = existingTypes.filter((t) => t !== triggerTypeDb);
  await db.update(taskItems).set({
    metadata: {
      ...((task.metadata as Record<string, unknown> | null) ?? {}),
      triggerTypes: remaining,
      hasTrigger: remaining.length > 0,
    },
  }).where(eq(taskItems.id, taskId));

  auditRequest(request, {
    eventType: 'data.delete',
    userId,
    resourceType: 'task_triggers',
    resourceId: taskId,
    details: { triggerType: triggerTypeDb },
  });

  void broadcastTaskEvent({
    type: 'task_updated',
    taskId,
    taskListId: task.taskListId,
    userId,
    pageId: taskList.pageId,
    data: { id: taskId, removedTriggerType: triggerTypeDb },
  });

  return NextResponse.json({ success: true });
}
