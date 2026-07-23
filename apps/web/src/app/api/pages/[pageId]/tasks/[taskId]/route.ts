import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq, and } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { taskItems, taskLists, taskStatusConfigs, taskAssignees } from '@pagespace/db/schema/tasks';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { canPrincipalEditPage } from '@/lib/auth'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { broadcastTaskEvent, broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { applyPageMutation, PageRevisionMismatchError } from '@/services/api/page-mutation-service';
import type { DeferredWorkflowTrigger } from '@pagespace/lib/monitoring/activity-logger';
import { createTaskAssignedNotification } from '@pagespace/lib/notifications/notifications';

import { syncTaskDueDateTrigger, cancelTaskDueDateTrigger, fireCompletionTrigger, disableTaskTriggers, createTaskTriggerWorkflow, type TaskTriggerWorkflowResult } from '@/lib/workflows/task-trigger-helpers';
import { checkSubTasksComplete, SUBTASKS_INCOMPLETE_STATUS } from '@/lib/tasks/completion-guard';
import { reorderTaskPeers } from '@/lib/ai/tools/task-helpers';
import { getUserTimezone } from '@/lib/ai/core/personalization-utils';
import { decryptTaskUserRelationsOne } from '@/lib/tasks/decrypt-task-relations';

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

  // Check MCP page scope
  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  // Check edit permission
  const canEdit = await canPrincipalEditPage(auth, pageId);
  if (!canEdit) {
    return NextResponse.json({
      error: 'You need edit permission to update tasks',
    }, { status: 403 });
  }

  // Look up task list for status config validation and broadcast metadata
  const taskList = await db.query.taskLists.findFirst({
    where: eq(taskLists.pageId, pageId),
  });

  // Verify task exists and its page is a direct child of this task list page
  const existingTask = await db.query.taskItems.findFirst({
    where: eq(taskItems.id, taskId),
    with: {
      page: { columns: { title: true, parentId: true } },
    },
  });

  if (!existingTask || existingTask.page?.parentId !== pageId) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  const body = await req.json();
  const { title, status, priority, assigneeId, assigneeAgentId, assigneeIds, dueDate, position, note, timezone, agentTrigger } = body;

  // Build update object
  const updates: Partial<typeof taskItems.$inferInsert> = {};
  let trimmedTitle: string | undefined;

  if (title !== undefined) {
    if (typeof title !== 'string' || title.trim().length === 0) {
      return NextResponse.json({ error: 'Title cannot be empty' }, { status: 400 });
    }
    trimmedTitle = title.trim();
  }

  let statusMovedToDone = false;

  if (status !== undefined) {
    // Validate against task list's custom status configs
    const validStatuses = taskList
      // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
      ? await db.query.taskStatusConfigs.findMany({
          where: eq(taskStatusConfigs.taskListId, taskList.id),
          columns: { slug: true, group: true },
        })
      : [];

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
        statusMovedToDone = !existingTask.completedAt; // Only true if newly completed
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
        statusMovedToDone = !existingTask.completedAt;
      } else if (existingTask.status === 'completed' && status !== 'completed') {
        updates.completedAt = null;
      }
    }
  }

  // Add note to metadata (mirrors the internal update_task tool)
  if (note || status !== undefined) {
    updates.metadata = {
      ...(existingTask.metadata as Record<string, unknown> || {}),
      lastUpdate: {
        at: new Date().toISOString(),
        note,
        ...(status !== undefined ? { statusChange: { from: existingTask.status, to: status } } : {}),
      },
    };
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

  // Validate agent entries in assigneeIds
  if (Array.isArray(assigneeIds)) {
    for (const entry of assigneeIds) {
      if (entry.type === 'agent' && entry.id) {
        const agentPage = await db.query.pages.findFirst({
          where: and(
            eq(pages.id, entry.id),
            eq(pages.type, 'AI_CHAT'),
            eq(pages.isTrashed, false)
          ),
          columns: { id: true, driveId: true },
        });

        if (!agentPage) {
          return NextResponse.json({ error: `Invalid agent ID "${entry.id}" - must be an AI agent page` }, { status: 400 });
        }

        if (taskListPage && agentPage.driveId !== taskListPage.driveId) {
          return NextResponse.json({ error: 'Agent must be in the same drive as the task list' }, { status: 400 });
        }
      }
    }
  }

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

  // Validate agentTrigger shape up front (before any writes), mirroring the POST route.
  let normalizedAgentTrigger: typeof agentTrigger | undefined;
  if (agentTrigger) {
    if (!taskListPage?.driveId) {
      return NextResponse.json({ error: 'Agent triggers require a drive-based task list' }, { status: 400 });
    }
    if (!agentTrigger.agentPageId || typeof agentTrigger.agentPageId !== 'string') {
      return NextResponse.json({ error: 'agentTrigger.agentPageId is required' }, { status: 400 });
    }
    if (!agentTrigger.prompt && !agentTrigger.instructionPageId) {
      return NextResponse.json({ error: 'Agent trigger needs either a prompt or instructionPageId' }, { status: 400 });
    }
    if (agentTrigger.prompt && (typeof agentTrigger.prompt !== 'string' || agentTrigger.prompt.length > 10000)) {
      return NextResponse.json({ error: 'agentTrigger.prompt must be a string of at most 10000 characters' }, { status: 400 });
    }
    const triggerType = agentTrigger.triggerType || 'due_date';
    if (triggerType !== 'due_date' && triggerType !== 'completion') {
      return NextResponse.json({ error: 'agentTrigger.triggerType must be "due_date" or "completion"' }, { status: 400 });
    }
    const effectiveDueDate = dueDate !== undefined ? (dueDate ? new Date(dueDate) : null) : existingTask.dueDate;
    if (triggerType === 'due_date' && !effectiveDueDate) {
      return NextResponse.json({ error: 'Due date is required for due_date triggers' }, { status: 400 });
    }
    if (agentTrigger.contextPageIds && (!Array.isArray(agentTrigger.contextPageIds) || agentTrigger.contextPageIds.length > 10)) {
      return NextResponse.json({ error: 'contextPageIds must be an array of at most 10 page IDs' }, { status: 400 });
    }
    normalizedAgentTrigger = { ...agentTrigger, triggerType };
  }

  // Completion guard: cannot mark a task done while it has incomplete sub-tasks
  if (updates.completedAt instanceof Date && existingTask.pageId) {
    const blocked = await checkSubTasksComplete(existingTask.pageId);
    if (blocked) {
      return NextResponse.json(blocked, { status: SUBTASKS_INCOMPLETE_STATUS });
    }
  }

  const actorInfo = await getActorInfo(userId);
  let linkedPageUpdated = false;

  // Fetch existing assignees before the transaction (for notification comparison)
  const existingAssignees = Array.isArray(assigneeIds)
    // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
    ? await db.query.taskAssignees.findMany({
        where: eq(taskAssignees.taskId, taskId),
        columns: { userId: true, agentPageId: true },
      })
    : [];

  // Update task and sync title to linked page if needed
  let updatedTask;
  let deferredTrigger: DeferredWorkflowTrigger | undefined;
  try {
    [updatedTask] = await db.transaction(async (tx) => {
      // Update the task (only if there are field-level updates)
      let task: typeof taskItems.$inferSelect = existingTask;
      if (Object.keys(updates).length > 0) {
        [task] = await tx.update(taskItems)
          .set(updates)
          .where(eq(taskItems.id, taskId))
          .returning();
      }

      // Title is owned by the linked page — sync there when it changes.
      if (trimmedTitle !== undefined) {
        const [linkedPage] = await tx
          .select({ revision: pages.revision })
          .from(pages)
          .where(eq(pages.id, existingTask.pageId))
          .limit(1);

        if (linkedPage) {
          const mutationResult = await applyPageMutation({
            pageId: existingTask.pageId,
            operation: 'update',
            updates: { title: trimmedTitle },
            updatedFields: ['title'],
            expectedRevision: linkedPage.revision,
            context: {
              userId,
              actorEmail: actorInfo.actorEmail,
              actorDisplayName: actorInfo.actorDisplayName ?? undefined,
              metadata: {
                taskId,
                taskListId: taskList?.id,
                taskListPageId: pageId,
              },
            },
            tx,
          });
          deferredTrigger = mutationResult.deferredTrigger;
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
    deferredTrigger?.();
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

  // Clamp to a slot in the list and move the task's page, matching the reorder_task
  // tool. The write lands on pages.position — the single ordering rail (#2143).
  if (position !== undefined) {
    await reorderTaskPeers(pageId, taskId, position, { userId });
  }

  // Create the agent trigger workflow after the transaction commits, mirroring update_task.
  let agentTriggerResult: TaskTriggerWorkflowResult | undefined;
  if (normalizedAgentTrigger && taskListPage?.driveId) {
    const resolvedTimezone = typeof timezone === 'string' && timezone.trim()
      ? timezone.trim()
      : (await getUserTimezone(userId)) || 'UTC';
    agentTriggerResult = await createTaskTriggerWorkflow({
      database: db,
      driveId: taskListPage.driveId,
      userId,
      taskId,
      taskMetadata: updatedTask.metadata as Record<string, unknown> | null,
      agentTrigger: normalizedAgentTrigger,
      dueDate: updatedTask.dueDate,
      timezone: resolvedTimezone,
    });
  }

  // Task trigger cascades (after transaction commits)
  if (dueDate !== undefined) {
    void syncTaskDueDateTrigger(taskId, dueDate ? new Date(dueDate) : null);
  }
  if (statusMovedToDone) {
    void cancelTaskDueDateTrigger(taskId, 'Task completed before due date');
    void fireCompletionTrigger(taskId);
  }

  // Fetch with relations (including assignees)
  const fetchedTask = await db.query.taskItems.findFirst({
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
      page: {
        columns: { id: true, title: true },
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

  if (!fetchedTask) {
    return NextResponse.json({ error: 'Task not found after update' }, { status: 404 });
  }

  const taskWithRelations = await decryptTaskUserRelationsOne(fetchedTask);

  const responseTitle = taskWithRelations.page?.title ?? '';

  // Send notification if assignee was changed to a new user
  if (assigneeId !== undefined && assigneeId !== existingTask.assigneeId && assigneeId !== null) {
    void createTaskAssignedNotification(
      assigneeId,
      taskId,
      responseTitle,
      pageId,
      userId
    );
  }

  // Send notifications for newly added user assignees (multi-assignee path)
  if (Array.isArray(assigneeIds)) {
    const previousUserIds = new Set(existingAssignees.map(a => a.userId).filter(Boolean));
    const newUserIds = assigneeIds
      .filter((a: { type: string; id: string }) => a.type === 'user' && a.id !== userId && !previousUserIds.has(a.id))
      .map((a: { id: string }) => a.id);
    for (const newUserId of newUserIds) {
      void createTaskAssignedNotification(
        newUserId,
        taskId,
        responseTitle,
        pageId,
        userId
      );
    }
  }

  // Surface the trigger created/updated by an inline agentTrigger — otherwise
  // the response is indistinguishable from an update that touched no trigger.
  const responseBody = {
    ...taskWithRelations,
    title: responseTitle,
    ...(agentTriggerResult ? { agentTrigger: agentTriggerResult } : {}),
  };

  // Broadcast events
  const broadcasts: Promise<void>[] = [
    broadcastTaskEvent({
      type: 'task_updated',
      taskId,
      taskListId: taskList?.id,
      userId,
      pageId,
      data: responseBody,
    }),
  ];

  if (linkedPageUpdated && taskListPage) {
    broadcasts.push(
      broadcastPageEvent(
        createPageEventPayload(taskListPage.driveId, existingTask.pageId, 'updated', {
          title: trimmedTitle,
        }),
      ),
    );
  }

  await Promise.all(broadcasts);

  const auditFields = [...Object.keys(updates), ...(trimmedTitle !== undefined ? ['title'] : [])];
  auditRequest(req, { eventType: 'data.write', userId, resourceType: 'task', resourceId: taskId, details: { action: 'update_task', pageId, updatedFields: auditFields } });

  return NextResponse.json(responseBody);
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

  // Check MCP page scope
  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  // Check edit permission
  const canEdit = await canPrincipalEditPage(auth, pageId);
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

  // Look up task list for broadcast metadata
  const taskList = await db.query.taskLists.findFirst({
    where: eq(taskLists.pageId, pageId),
  });

  // Verify task exists and its page is a direct child of this task list page
  const existingTask = await db.query.taskItems.findFirst({
    where: eq(taskItems.id, taskId),
    with: {
      page: { columns: { title: true, parentId: true } },
    },
  });

  if (!existingTask || existingTask.page?.parentId !== pageId) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  const linkedPageId = existingTask.pageId;
  const existingTitle = existingTask.page?.title ?? '';

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
            taskListId: taskList?.id,
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

  // Disable triggers before hard-deleting the task row: task_triggers cascades on
  // taskItemId, so deleting first would wipe the rows this helper needs to read.
  await disableTaskTriggers(taskId, 'Task deleted');

  // Hard-delete the task row (REST parity with the internal delete_task tool) —
  // trashing the linked page alone left a resurrectable "deleted" task: restoring
  // the trashed page brought the task back since the taskItems row still existed.
  await db.delete(taskItems).where(eq(taskItems.id, taskId));

  // Broadcast events
  const broadcasts: Promise<void>[] = [
    broadcastTaskEvent({
      type: 'task_deleted',
      taskId,
      taskListId: taskList?.id,
      userId,
      pageId,
      data: { id: taskId },
    }),
  ];

  if (linkedPage && taskListPage) {
    broadcasts.push(
      broadcastPageEvent(
        createPageEventPayload(taskListPage.driveId, linkedPageId, 'trashed', {
          title: existingTitle,
          parentId: pageId,
        }),
      ),
    );
  }

  await Promise.all(broadcasts);

  auditRequest(req, { eventType: 'data.delete', userId, resourceType: 'task', resourceId: taskId, details: { action: 'delete_task', pageId } });

  return NextResponse.json({ success: true });
}
