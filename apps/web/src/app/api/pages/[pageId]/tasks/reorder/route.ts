import { NextResponse } from 'next/server';
import { db, taskItems, taskLists, eq } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/server';
import { broadcastTaskEvent } from '@/lib/websocket/socket-utils';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

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

  // Check edit permission
  const canEdit = await canUserEditPage(userId, pageId);
  if (!canEdit) {
    return NextResponse.json({
      error: 'You need edit permission to reorder tasks',
    }, { status: 403 });
  }

  // Verify task list exists for this page
  const taskList = await db.query.taskLists.findFirst({
    where: eq(taskLists.pageId, pageId),
  });

  if (!taskList) {
    return NextResponse.json({ error: 'Task list not found' }, { status: 404 });
  }

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

  // Update positions in a transaction
  await db.transaction(async (tx) => {
    for (const task of tasks) {
      await tx.update(taskItems)
        .set({ position: task.position })
        .where(eq(taskItems.id, task.id));
    }
  });

  // Broadcast reorder event
  await broadcastTaskEvent({
    type: 'tasks_reordered',
    taskId: tasks[0]?.id ?? '',
    taskListId: taskList.id,
    userId,
    pageId,
    data: { tasks },
  });

  return NextResponse.json({ success: true });
}
