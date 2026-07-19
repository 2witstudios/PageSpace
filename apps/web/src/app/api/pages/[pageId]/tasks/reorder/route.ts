import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { taskLists } from '@pagespace/db/schema/tasks';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { canPrincipalEditPage } from '@/lib/auth'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { broadcastTaskEvent } from '@/lib/websocket';
import { getActorInfo, logPageActivity } from '@pagespace/lib/monitoring/activity-logger';
import { computeReorderPlan } from '@pagespace/lib/services/reorder';
import { reorderTaskListChildren } from './reorder-task-list';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

/**
 * PATCH /api/pages/[pageId]/tasks/reorder
 * Bulk update task positions for drag-and-drop reordering
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ pageId: string }> }
) {
  const { pageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  // Check MCP page scope
  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  // Check edit permission
  const canEdit = await canPrincipalEditPage(auth, pageId);
  if (!canEdit) {
    return NextResponse.json({
      error: 'You need edit permission to reorder tasks',
    }, { status: 403 });
  }

  // Get task list page for driveId
  const taskListPage = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
    columns: { driveId: true, title: true },
  });

  // Look up task list for broadcast metadata (non-fatal if missing)
  const taskList = await db.query.taskLists.findFirst({
    where: eq(taskLists.pageId, pageId),
  });

  const body = await req.json();
  const { tasks } = body;

  if (!Array.isArray(tasks)) {
    return NextResponse.json({ error: 'tasks must be an array' }, { status: 400 });
  }

  // Validate format: [{ id: string, position: number }]
  for (const task of tasks) {
    if (!task.id || typeof task.position !== 'number') {
      return NextResponse.json({
        error: 'Each task must have id and position',
      }, { status: 400 });
    }
  }

  // Update positions via the locked-batch primitive (Phase 3): locks every
  // target row FOR UPDATE in ascending-id order, then writes all positions in
  // one batched statement — replaces the N-sequential-unordered-update loop
  // that deadlocked production Postgres on 2026-07-18.
  const plan = computeReorderPlan(tasks);
  if (plan.orderedIds.length > 0) {
    try {
      await db.transaction(async (tx) => {
        const lockedIds = await reorderTaskListChildren(tx, pageId, plan);

        if (lockedIds.length !== plan.orderedIds.length) {
          throw new Error('Invalid task IDs');
        }
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Invalid task IDs') {
        return NextResponse.json({ error: 'Invalid task IDs' }, { status: 400 });
      }
      throw error;
    }
  }

  // Broadcast reorder event
  await broadcastTaskEvent({
    type: 'tasks_reordered',
    taskId: tasks[0]?.id ?? '',
    taskListId: taskList?.id,
    userId,
    pageId,
    data: { tasks },
  });

  // Log task reorder for compliance (fire-and-forget)
  if (taskListPage) {
    const actorInfo = await getActorInfo(userId);
    logPageActivity(userId, 'reorder', {
      id: pageId,
      title: taskListPage.title || 'Task List',
      driveId: taskListPage.driveId,
    }, {
      ...actorInfo,
      metadata: {
        taskListId: taskList?.id,
        reorderedTaskIds: tasks.map((t: { id: string }) => t.id),
        newPositions: tasks.map((t: { id: string; position: number }) => ({
          id: t.id,
          position: t.position,
        })),
      },
    });
  }

  auditRequest(req, { eventType: 'data.write', userId, resourceType: 'task', resourceId: pageId, details: { action: 'reorder_tasks', taskCount: tasks.length } });

  return NextResponse.json({ success: true });
}
