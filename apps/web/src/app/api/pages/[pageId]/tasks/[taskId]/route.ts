import { NextResponse } from 'next/server';
import { db, taskItems, taskLists, eq, and } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/server';
import { broadcastTaskEvent } from '@/lib/websocket/socket-utils';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

/**
 * PATCH /api/pages/[pageId]/tasks/[taskId]
 * Update a task
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ pageId: string; taskId: string }> }
) {
  const { pageId, taskId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  // Check edit permission
  const canEdit = await canUserEditPage(userId, pageId);
  if (!canEdit) {
    return NextResponse.json({
      error: 'You need edit permission to update tasks',
    }, { status: 403 });
  }

  // Verify task belongs to this page's task list
  const taskList = await db.query.taskLists.findFirst({
    where: eq(taskLists.pageId, pageId),
  });

  if (!taskList) {
    return NextResponse.json({ error: 'Task list not found' }, { status: 404 });
  }

  const existingTask = await db.query.taskItems.findFirst({
    where: and(
      eq(taskItems.id, taskId),
      eq(taskItems.taskListId, taskList.id),
    ),
  });

  if (!existingTask) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  const body = await req.json();
  const { title, description, status, priority, assigneeId, dueDate, position } = body;

  // Build update object
  const updates: Partial<typeof taskItems.$inferInsert> = {};

  if (title !== undefined) {
    if (typeof title !== 'string' || title.trim().length === 0) {
      return NextResponse.json({ error: 'Title cannot be empty' }, { status: 400 });
    }
    updates.title = title.trim();
  }

  if (description !== undefined) {
    updates.description = description?.trim() || null;
  }

  if (status !== undefined) {
    if (!['pending', 'in_progress', 'completed', 'blocked'].includes(status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }
    updates.status = status;
    // Set completedAt when marking as completed
    if (status === 'completed') {
      updates.completedAt = new Date();
    } else if (existingTask.status === 'completed' && status !== 'completed') {
      updates.completedAt = null;
    }
  }

  if (priority !== undefined) {
    if (!['low', 'medium', 'high'].includes(priority)) {
      return NextResponse.json({ error: 'Invalid priority' }, { status: 400 });
    }
    updates.priority = priority;
  }

  if (assigneeId !== undefined) {
    updates.assigneeId = assigneeId || null;
  }

  if (dueDate !== undefined) {
    updates.dueDate = dueDate ? new Date(dueDate) : null;
  }

  if (position !== undefined) {
    updates.position = position;
  }

  // Update task
  const [updatedTask] = await db.update(taskItems)
    .set(updates)
    .where(eq(taskItems.id, taskId))
    .returning();

  // Fetch with relations
  const taskWithRelations = await db.query.taskItems.findFirst({
    where: eq(taskItems.id, updatedTask.id),
    with: {
      assignee: {
        columns: {
          id: true,
          name: true,
          image: true,
        },
      },
      user: {
        columns: {
          id: true,
          name: true,
          image: true,
        },
      },
    },
  });

  if (!taskWithRelations) {
    return NextResponse.json({ error: 'Task not found after update' }, { status: 404 });
  }

  // Broadcast task update
  await broadcastTaskEvent({
    type: 'task_updated',
    taskId,
    taskListId: taskList.id,
    userId,
    pageId,
    data: taskWithRelations,
  });

  return NextResponse.json(taskWithRelations);
}

/**
 * DELETE /api/pages/[pageId]/tasks/[taskId]
 * Delete a task
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ pageId: string; taskId: string }> }
) {
  const { pageId, taskId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  // Check edit permission
  const canEdit = await canUserEditPage(userId, pageId);
  if (!canEdit) {
    return NextResponse.json({
      error: 'You need edit permission to delete tasks',
    }, { status: 403 });
  }

  // Verify task belongs to this page's task list
  const taskList = await db.query.taskLists.findFirst({
    where: eq(taskLists.pageId, pageId),
  });

  if (!taskList) {
    return NextResponse.json({ error: 'Task list not found' }, { status: 404 });
  }

  const existingTask = await db.query.taskItems.findFirst({
    where: and(
      eq(taskItems.id, taskId),
      eq(taskItems.taskListId, taskList.id),
    ),
  });

  if (!existingTask) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  // Delete task
  await db.delete(taskItems).where(eq(taskItems.id, taskId));

  // Broadcast task deletion
  await broadcastTaskEvent({
    type: 'task_deleted',
    taskId,
    taskListId: taskList.id,
    userId,
    pageId,
    data: { id: taskId },
  });

  return NextResponse.json({ success: true });
}
