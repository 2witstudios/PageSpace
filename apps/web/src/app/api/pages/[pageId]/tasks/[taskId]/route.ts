import { NextResponse } from 'next/server';
import { db, taskItems, taskLists, pages, eq, and } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/server';
import { broadcastTaskEvent, broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';

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

  // Get task list page for driveId (needed for page broadcasts)
  const taskListPage = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
    columns: { driveId: true },
  });

  // Update task and sync title to linked page if needed
  const [updatedTask] = await db.transaction(async (tx) => {
    // Update the task
    const [task] = await tx.update(taskItems)
      .set(updates)
      .where(eq(taskItems.id, taskId))
      .returning();

    // If title changed and task has a linked page, update the page title too
    if (updates.title && existingTask.pageId) {
      await tx.update(pages)
        .set({ title: updates.title, updatedAt: new Date() })
        .where(eq(pages.id, existingTask.pageId));
    }

    return [task];
  });

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

  // Broadcast events
  const broadcasts: Promise<void>[] = [
    broadcastTaskEvent({
      type: 'task_updated',
      taskId,
      taskListId: taskList.id,
      userId,
      pageId,
      data: taskWithRelations,
    }),
  ];

  // If title changed and task has a linked page, broadcast page update
  if (updates.title && existingTask.pageId && taskListPage) {
    broadcasts.push(
      broadcastPageEvent(
        createPageEventPayload(taskListPage.driveId, existingTask.pageId, 'updated', {
          title: updates.title,
        }),
      ),
    );
  }

  await Promise.all(broadcasts);

  return NextResponse.json(taskWithRelations);
}

/**
 * DELETE /api/pages/[pageId]/tasks/[taskId]
 * "Delete" a task by trashing its linked page
 * The task record remains but is filtered out in queries (page.isTrashed = true)
 * Restoring the page will restore the task to the list
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

  // Get task list page for driveId (needed for page broadcasts)
  const taskListPage = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
    columns: { driveId: true },
  });

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

  const linkedPageId = existingTask.pageId;

  if (!linkedPageId) {
    // Task without a page (conversation-based) - delete the task record directly
    await db.delete(taskItems).where(eq(taskItems.id, taskId));

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

  // Task has a linked page - trash the page (task remains but is filtered out)
  await db.update(pages)
    .set({ isTrashed: true, trashedAt: new Date() })
    .where(eq(pages.id, linkedPageId));

  // Broadcast events
  const broadcasts: Promise<void>[] = [
    broadcastTaskEvent({
      type: 'task_deleted',
      taskId,
      taskListId: taskList.id,
      userId,
      pageId,
      data: { id: taskId },
    }),
  ];

  // Broadcast page trashed event for sidebar update
  if (taskListPage) {
    broadcasts.push(
      broadcastPageEvent(
        createPageEventPayload(taskListPage.driveId, linkedPageId, 'trashed', {
          title: existingTask.title,
          parentId: pageId,
        }),
      ),
    );
  }

  await Promise.all(broadcasts);

  return NextResponse.json({ success: true });
}
