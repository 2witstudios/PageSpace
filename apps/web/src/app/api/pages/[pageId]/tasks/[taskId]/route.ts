import { NextResponse } from 'next/server';
import { db, taskItems, taskLists, taskStatusConfigs, taskAssignees, pages, eq, and } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/server';
import { broadcastTaskEvent, broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { getActorInfo, logPageActivity } from '@pagespace/lib/monitoring/activity-logger';
import { applyPageMutation, PageRevisionMismatchError } from '@/services/api/page-mutation-service';
import { createTaskAssignedNotification } from '@pagespace/lib/notifications';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

/**
 * PATCH /api/pages/[pageId]/tasks/[taskId]
 * Update a task - supports custom statuses and multiple assignees
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
  const { title, description, status, priority, assigneeId, assigneeAgentId, assigneeIds, dueDate, position } = body;

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
    // Validate against task list's custom status configs
    const validStatuses = await db.query.taskStatusConfigs.findMany({
      where: eq(taskStatusConfigs.taskListId, taskList.id),
      columns: { slug: true, group: true },
    });

    if (validStatuses.length > 0) {
      const validConfig = validStatuses.find(s => s.slug === status);
      if (!validConfig) {
        const validSlugs = validStatuses.map(s => s.slug);
        return NextResponse.json({ error: `Invalid status "${status}". Valid statuses: ${validSlugs.join(', ')}` }, { status: 400 });
      }
      updates.status = status;
      // Set completedAt based on status group
      if (validConfig.group === 'done') {
        updates.completedAt = new Date();
      } else if (existingTask.completedAt) {
        updates.completedAt = null;
      }
    } else {
      // Fallback for task lists without custom configs
      if (!['pending', 'in_progress', 'completed', 'blocked'].includes(status)) {
        return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
      }
      updates.status = status;
      if (status === 'completed') {
        updates.completedAt = new Date();
      } else if (existingTask.status === 'completed' && status !== 'completed') {
        updates.completedAt = null;
      }
    }
  }

  if (priority !== undefined) {
    if (!['low', 'medium', 'high'].includes(priority)) {
      return NextResponse.json({ error: 'Invalid priority' }, { status: 400 });
    }
    updates.priority = priority;
  }

  // Handle legacy single-assignee fields
  if (assigneeId !== undefined) {
    updates.assigneeId = assigneeId || null;
  }

  // Get task list page for driveId (needed for validation and broadcasts)
  const taskListPage = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
    columns: { driveId: true },
  });

  if (assigneeAgentId !== undefined) {
    if (assigneeAgentId) {
      const agentPage = await db.query.pages.findFirst({
        where: and(
          eq(pages.id, assigneeAgentId),
          eq(pages.type, 'AI_CHAT'),
          eq(pages.isTrashed, false)
        ),
        columns: { id: true, driveId: true },
      });

      if (!agentPage) {
        return NextResponse.json({ error: 'Invalid agent ID - must be an AI agent page' }, { status: 400 });
      }

      if (taskListPage && agentPage.driveId !== taskListPage.driveId) {
        return NextResponse.json({ error: 'Agent must be in the same drive as the task list' }, { status: 400 });
      }
    }
    updates.assigneeAgentId = assigneeAgentId || null;
  }

  if (dueDate !== undefined) {
    updates.dueDate = dueDate ? new Date(dueDate) : null;
  }

  if (position !== undefined) {
    updates.position = position;
  }

  const actorInfo = await getActorInfo(userId);
  let linkedPageUpdated = false;

  // Update task and sync title to linked page if needed
  let updatedTask;
  try {
    [updatedTask] = await db.transaction(async (tx) => {
      // Update the task
      const [task] = await tx.update(taskItems)
        .set(updates)
        .where(eq(taskItems.id, taskId))
        .returning();

      // If title changed and task has a linked page, update the page title too
      if (updates.title && existingTask.pageId) {
        const [linkedPage] = await tx
          .select({ revision: pages.revision })
          .from(pages)
          .where(eq(pages.id, existingTask.pageId))
          .limit(1);

        if (linkedPage) {
          await applyPageMutation({
            pageId: existingTask.pageId,
            operation: 'update',
            updates: { title: updates.title },
            updatedFields: ['title'],
            expectedRevision: linkedPage.revision,
            context: {
              userId,
              actorEmail: actorInfo.actorEmail,
              actorDisplayName: actorInfo.actorDisplayName ?? undefined,
              metadata: {
                taskId,
                taskListId: taskList.id,
                taskListPageId: pageId,
              },
            },
            tx,
          });
          linkedPageUpdated = true;
        }
      }

      // Handle multiple assignees update
      if (Array.isArray(assigneeIds)) {
        // Delete existing assignees
        await tx.delete(taskAssignees).where(eq(taskAssignees.taskId, taskId));

        // Insert new assignees
        const assigneeRows: { taskId: string; userId?: string; agentPageId?: string }[] = [];
        for (const entry of assigneeIds) {
          if (entry.type === 'user' && entry.id) {
            assigneeRows.push({ taskId, userId: entry.id });
          } else if (entry.type === 'agent' && entry.id) {
            assigneeRows.push({ taskId, agentPageId: entry.id });
          }
        }

        if (assigneeRows.length > 0) {
          await tx.insert(taskAssignees).values(assigneeRows);
        }

        // Update legacy fields to first user/agent for backward compat
        const firstUser = assigneeIds.find((a: { type: string }) => a.type === 'user');
        const firstAgent = assigneeIds.find((a: { type: string }) => a.type === 'agent');
        await tx.update(taskItems).set({
          assigneeId: firstUser?.id || null,
          assigneeAgentId: firstAgent?.id || null,
        }).where(eq(taskItems.id, taskId));
      } else if (assigneeId !== undefined || assigneeAgentId !== undefined) {
        // Legacy single-assignee update: sync to junction table
        await tx.delete(taskAssignees).where(eq(taskAssignees.taskId, taskId));

        const assigneeRows: { taskId: string; userId?: string; agentPageId?: string }[] = [];
        const newAssigneeId = assigneeId !== undefined ? (assigneeId || null) : existingTask.assigneeId;
        const newAgentId = assigneeAgentId !== undefined ? (assigneeAgentId || null) : existingTask.assigneeAgentId;

        if (newAssigneeId) {
          assigneeRows.push({ taskId, userId: newAssigneeId });
        }
        if (newAgentId) {
          assigneeRows.push({ taskId, agentPageId: newAgentId });
        }

        if (assigneeRows.length > 0) {
          await tx.insert(taskAssignees).values(assigneeRows);
        }
      }

      return [task];
    });
  } catch (error) {
    if (error instanceof PageRevisionMismatchError) {
      return NextResponse.json(
        {
          error: error.message,
          currentRevision: error.currentRevision,
          expectedRevision: error.expectedRevision,
        },
        { status: error.expectedRevision === undefined ? 428 : 409 }
      );
    }
    throw error;
  }

  // Fetch with relations (including assignees)
  const taskWithRelations = await db.query.taskItems.findFirst({
    where: eq(taskItems.id, updatedTask.id),
    with: {
      assignee: {
        columns: { id: true, name: true, image: true },
      },
      assigneeAgent: {
        columns: { id: true, title: true, type: true },
      },
      user: {
        columns: { id: true, name: true, image: true },
      },
      assignees: {
        with: {
          user: {
            columns: { id: true, name: true, image: true },
          },
          agentPage: {
            columns: { id: true, title: true, type: true },
          },
        },
      },
    },
  });

  if (!taskWithRelations) {
    return NextResponse.json({ error: 'Task not found after update' }, { status: 404 });
  }

  // Send notification if assignee was changed to a new user
  if (assigneeId !== undefined && assigneeId !== existingTask.assigneeId && assigneeId !== null) {
    void createTaskAssignedNotification(
      assigneeId,
      taskId,
      taskWithRelations.title,
      pageId,
      userId
    );
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

  if (linkedPageUpdated && taskListPage && existingTask.pageId) {
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

  // Get task list page for driveId
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

    if (taskListPage) {
      const actorInfo = await getActorInfo(userId);
      logPageActivity(userId, 'delete', {
        id: pageId,
        title: existingTask.title,
        driveId: taskListPage.driveId,
      }, {
        ...actorInfo,
        metadata: {
          taskId,
          taskListId: taskList.id,
          taskListPageId: pageId,
          isConversationTask: true,
        },
      });
    }

    return NextResponse.json({ success: true });
  }

  // Task has a linked page - trash the page
  const actorInfo = await getActorInfo(userId);
  const [linkedPage] = await db
    .select({ revision: pages.revision })
    .from(pages)
    .where(eq(pages.id, linkedPageId))
    .limit(1);

  if (linkedPage) {
    try {
      await applyPageMutation({
        pageId: linkedPageId,
        operation: 'trash',
        updates: { isTrashed: true, trashedAt: new Date() },
        updatedFields: ['isTrashed', 'trashedAt'],
        expectedRevision: linkedPage.revision,
        context: {
          userId,
          actorEmail: actorInfo.actorEmail,
          actorDisplayName: actorInfo.actorDisplayName ?? undefined,
          metadata: {
            taskId,
            taskListId: taskList.id,
            taskListPageId: pageId,
          },
        },
      });
    } catch (error) {
      if (error instanceof PageRevisionMismatchError) {
        return NextResponse.json(
          {
            error: error.message,
            currentRevision: error.currentRevision,
            expectedRevision: error.expectedRevision,
          },
          { status: error.expectedRevision === undefined ? 428 : 409 }
        );
      }
      throw error;
    }
  }

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

  if (linkedPage && taskListPage) {
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
