import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db'
import { eq, and, desc, asc, inArray } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { taskLists, taskItems, taskStatusConfigs, taskAssignees } from '@pagespace/db/schema/tasks';
import type { ToolExecutionContext } from '../core/types';
import { broadcastTaskEvent, broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { canActorEditPage } from './actor-permissions';
import { logPageActivity, getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import type { DeferredWorkflowTrigger } from '@pagespace/lib/monitoring/activity-logger';
import { createTaskTriggerWorkflow, disableTaskTriggers } from '@/lib/workflows/task-trigger-helpers';
import type { AgentTriggerInput } from '@/lib/workflows/task-trigger-helpers';
import { applyPageMutation, PageRevisionMismatchError } from '@/services/api/page-mutation-service';
import { reorderTaskListChildPages } from '@/services/api/task-reorder-service';
import { compareByPagePosition, computeTaskMovePosition } from '@/services/api/task-ordering';
import { computeReorderPlan } from '@pagespace/lib/services/reorder';
import { decryptTaskUserRelations } from '@/lib/tasks/decrypt-task-relations';

/**
 * The Drizzle transaction handle passed to `db.transaction(async (tx) => ...)`.
 * Derived from the live db type so it never drifts.
 */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Normalize an agentTrigger payload: trim prompt/instructionPageId and collapse
 * an empty trigger (no prompt and no instruction page) to undefined so a blank
 * object doesn't schedule a no-op workflow.
 */
export function normalizeTaskAgentTriggerInput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const candidate = value as {
    prompt?: unknown;
    instructionPageId?: unknown;
  };

  const prompt = typeof candidate.prompt === 'string' ? candidate.prompt.trim() : '';
  const instructionPageId = typeof candidate.instructionPageId === 'string' ? candidate.instructionPageId.trim() : '';

  if (!prompt && !instructionPageId) {
    return undefined;
  }

  return {
    ...candidate,
    ...(prompt ? { prompt } : {}),
    ...(instructionPageId ? { instructionPageId } : {}),
  };
}

/**
 * Extract AI attribution context with actor info for activity logging.
 */
export async function getAiContextWithActor(context: ToolExecutionContext) {
  const actorInfo = await getActorInfo(context.userId);
  // Build chain metadata (Tier 1)
  const chainMetadata = {
    ...(context.parentAgentId && { parentAgentId: context.parentAgentId }),
    ...(context.parentConversationId && { parentConversationId: context.parentConversationId }),
    ...(context.agentChain?.length && { agentChain: context.agentChain }),
    ...(context.requestOrigin && { requestOrigin: context.requestOrigin }),
  };

  return {
    ...actorInfo,
    isAiGenerated: true,
    aiProvider: context.aiProvider,
    aiModel: context.aiModel,
    aiConversationId: context.conversationId,
    metadata: Object.keys(chainMetadata).length > 0 ? chainMetadata : undefined,
  };
}

/**
 * Verify page access for page-linked task lists.
 */
export async function verifyPageAccess(context: ToolExecutionContext, pageId: string): Promise<boolean> {
  return canActorEditPage(context, pageId);
}

async function fetchTaskForUpdate(taskId: string) {
  return db.query.taskItems.findFirst({
    where: eq(taskItems.id, taskId),
    with: {
      page: { columns: { title: true, parentId: true, position: true } },
    },
  });
}

/** A task row joined with its linked page's title/parentId/position. */
export type TaskForUpdate = NonNullable<Awaited<ReturnType<typeof fetchTaskForUpdate>>>;

/**
 * Resolve the existing task and its owning task list, then verify the actor may
 * edit it. Throws with a human-readable message on missing task/list or
 * insufficient permission. Shared by update_task, delete_task, and reorder_task.
 */
export async function resolveTaskForUpdate(
  context: ToolExecutionContext,
  userId: string,
  taskId: string,
): Promise<{ existingTask: TaskForUpdate; taskList: typeof taskLists.$inferSelect }> {
  const existingTask = await fetchTaskForUpdate(taskId);

  if (!existingTask) {
    throw new Error('Task not found');
  }

  const taskList = await db.query.taskLists.findFirst({
    where: eq(taskLists.pageId, existingTask.page?.parentId ?? ''),
  });

  if (!taskList) {
    throw new Error('Task list not found');
  }

  if (taskList.pageId) {
    const hasAccess = await verifyPageAccess(context, taskList.pageId);
    if (!hasAccess) {
      throw new Error('You do not have permission to update tasks on this page');
    }
  } else if (taskList.userId !== userId) {
    throw new Error('You do not have permission to update this task');
  }

  return { existingTask, taskList };
}

/**
 * Replace a task's assignees inside a transaction.
 *
 * `assigneeIds` as an array is treated as a full replace (matching the REST
 * PATCH route, so callers can clear all assignees with []). Otherwise the legacy
 * single-assignee fields are synced into the junction table when provided.
 */
export async function syncTaskAssignees(
  tx: DbTransaction,
  taskId: string,
  params: {
    assigneeIds?: { type: 'user' | 'agent'; id: string }[];
    assigneeId?: string | null;
    assigneeAgentId?: string | null;
  },
): Promise<void> {
  const { assigneeIds, assigneeId, assigneeAgentId } = params;

  if (Array.isArray(assigneeIds)) {
    await tx.delete(taskAssignees).where(eq(taskAssignees.taskId, taskId));
    const rows = assigneeIds
      .filter(a => a.id)
      .map(a => ({
        taskId,
        ...(a.type === 'user' ? { userId: a.id } : { agentPageId: a.id }),
      }));
    if (rows.length > 0) {
      await tx.insert(taskAssignees).values(rows);
    }

    // Sync legacy fields
    const firstUser = assigneeIds.find(a => a.type === 'user' && a.id);
    const firstAgent = assigneeIds.find(a => a.type === 'agent' && a.id);
    await tx.update(taskItems).set({
      assigneeId: firstUser?.id || null,
      assigneeAgentId: firstAgent?.id || null,
    }).where(eq(taskItems.id, taskId));
  } else if (assigneeId !== undefined || assigneeAgentId !== undefined) {
    // Legacy single-assignee: sync to junction table
    await tx.delete(taskAssignees).where(eq(taskAssignees.taskId, taskId));
    const rows: { taskId: string; userId?: string; agentPageId?: string }[] = [];
    if (assigneeId) rows.push({ taskId, userId: assigneeId });
    if (assigneeAgentId) rows.push({ taskId, agentPageId: assigneeAgentId });
    if (rows.length > 0) await tx.insert(taskAssignees).values(rows);
  }
}

export async function fetchEnrichedTasks(parentPageId: string) {
  // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
  const tasks = await db.query.taskItems.findMany({
    where: inArray(taskItems.pageId, db.select({ id: pages.id }).from(pages).where(and(
      eq(pages.parentId, parentPageId),
      eq(pages.type, 'TASK_LIST'),
      eq(pages.isTrashed, false),
    ))),
    with: {
      assignee: { columns: { id: true, name: true, image: true } },
      assigneeAgent: { columns: { id: true, title: true, type: true } },
      page: { columns: { title: true, content: true, position: true } },
      assignees: {
        with: {
          user: { columns: { id: true, name: true } },
          agentPage: { columns: { id: true, title: true } },
        },
      },
    },
  });
  // Ordered in JS, not SQL: the ordering rail is pages.position on the joined page,
  // and a relational findMany cannot order by a joined table's column. Same order the
  // GET tasks route serves, so AI tools and the UI never disagree (#2143).
  const decrypted = await decryptTaskUserRelations(tasks);
  return decrypted.sort((a, b) => compareByPagePosition(a, b));
}

type EnrichedTaskItem = Awaited<ReturnType<typeof fetchEnrichedTasks>>[number];

/** Serialize one enriched task row to the tool response shape (shared by all task tools). */
export function serializeTaskItem(t: EnrichedTaskItem) {
  return {
    id: t.id,
    title: t.page?.title ?? '',
    status: t.status,
    priority: t.priority,
    assigneeId: t.assigneeId,
    assigneeAgentId: t.assigneeAgentId,
    dueDate: t.dueDate,
    // Sourced from the linked page — the single ordering rail (#2143).
    position: t.page?.position ?? 0,
    completedAt: t.completedAt,
    pageId: t.pageId,
    assignee: t.assignee ? {
      id: t.assignee.id,
      name: t.assignee.name,
      image: t.assignee.image,
    } : null,
    assigneeAgent: t.assigneeAgent ? {
      id: t.assigneeAgent.id,
      title: t.assigneeAgent.title,
      type: t.assigneeAgent.type,
    } : null,
    assignees: t.assignees?.map(a => ({
      userId: a.userId,
      agentPageId: a.agentPageId,
      user: a.user ? { id: a.user.id, name: a.user.name } : null,
      agentPage: a.agentPage ? { id: a.agentPage.id, title: a.agentPage.title } : null,
    })) || [],
  };
}

/**
 * Emit the `task_updated` event so collaborators and other clients see field
 * edits and reorders. Shared by update_task and reorder_task so both surfaces
 * broadcast the same payload shape.
 */
export async function broadcastTaskUpdated(params: {
  taskId: string;
  userId: string;
  taskListPageId: string | null;
  title: string;
  note?: string;
}): Promise<void> {
  await broadcastTaskEvent({
    type: 'task_updated',
    taskId: params.taskId,
    userId: params.userId,
    pageId: params.taskListPageId || undefined,
    data: { title: params.title, note: params.note },
  });
}

/** Serialize the refreshed task list to the tool response shape. */
export function serializeTaskList(
  tl: typeof taskLists.$inferSelect | undefined,
  driveId: string | undefined,
) {
  return tl ? {
    id: tl.id,
    title: tl.title,
    description: tl.description,
    status: tl.status,
    pageId: tl.pageId,
    driveId,
  } : null;
}

type TaskResponseTask = Pick<
  typeof taskItems.$inferSelect,
  'id' | 'status' | 'priority' | 'assigneeId' | 'assigneeAgentId' | 'dueDate' | 'completedAt' | 'pageId'
> & {
  /** The linked page's position — task rows carry no position of their own (#2143). */
  position: number;
};

/**
 * Build the shared create/update/reorder response: the acted-on task, the
 * refreshed task list (with driveId), and every task in the list. Callers pass
 * the parent TASK_LIST page id used to scope the list query.
 */
export async function buildTaskListResponse(params: {
  action: 'created' | 'updated';
  parentPageId: string;
  taskListId: string;
  resultTask: TaskResponseTask;
  resultTitle: string;
  message: string;
}) {
  const { action, parentPageId, taskListId, resultTask, resultTitle, message } = params;

  // Get all tasks for response with assignee relations
  const allTasks = await fetchEnrichedTasks(parentPageId);

  // Refresh task list with page info for driveId
  const refreshedTaskList = await db.query.taskLists.findFirst({
    where: eq(taskLists.id, taskListId),
  });

  // Get driveId from the associated page
  let driveId: string | undefined;
  if (refreshedTaskList?.pageId) {
    const taskListPage = await db.query.pages.findFirst({
      where: eq(pages.id, refreshedTaskList.pageId),
      columns: { driveId: true },
    });
    driveId = taskListPage?.driveId;
  }

  return {
    success: true,
    action,
    task: {
      id: resultTask.id,
      title: resultTitle,
      status: resultTask.status,
      priority: resultTask.priority,
      assigneeId: resultTask.assigneeId,
      assigneeAgentId: resultTask.assigneeAgentId,
      dueDate: resultTask.dueDate,
      position: resultTask.position,
      completedAt: resultTask.completedAt,
      pageId: resultTask.pageId,
    },
    taskList: serializeTaskList(refreshedTaskList, driveId),
    tasks: allTasks.map(serializeTaskItem),
    message,
  };
}

export interface CreateTaskParams {
  pageId: string;
  title: string;
  status?: string;
  priority?: 'low' | 'medium' | 'high';
  assigneeId?: string | null;
  assigneeAgentId?: string | null;
  assigneeIds?: { type: 'user' | 'agent'; id: string }[];
  dueDate?: string | null;
  note?: string;
  position?: number;
  agentTrigger?: AgentTriggerInput;
}

/**
 * Create a task on a TASK_LIST page: validates access + status, auto-creates the
 * task_list record, inserts a linked TASK_LIST page (holding the description /
 * sub-tasks) plus the task row, wires assignees and any agent trigger, then
 * broadcasts and returns the refreshed list. Backs the create_task tool.
 */
export async function createTask(
  context: ToolExecutionContext,
  userId: string,
  params: CreateTaskParams,
) {
  const { pageId, title, status, priority, assigneeId, assigneeAgentId, assigneeIds, dueDate, note, position, agentTrigger } = params;

  // Reject blank/whitespace titles, matching the update path and REST task route.
  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    throw new Error('Title cannot be empty');
  }

  // Get the TASK_LIST page and verify access
  const taskListPage = await db.query.pages.findFirst({
    where: and(eq(pages.id, pageId), eq(pages.isTrashed, false)),
    columns: { id: true, driveId: true, type: true, title: true },
  });

  if (!taskListPage) {
    throw new Error('Page not found');
  }

  if (taskListPage.type !== 'TASK_LIST') {
    throw new Error('Page must be a TASK_LIST page to add tasks');
  }

  const hasAccess = await verifyPageAccess(context, pageId);
  if (!hasAccess) {
    throw new Error('You do not have permission to add tasks to this page');
  }

  // Find or create task_list record for this page
  let taskList = await db.query.taskLists.findFirst({
    where: eq(taskLists.pageId, pageId),
  });

  if (!taskList) {
    // Auto-create task_list record for this page
    const [newTaskList] = await db.insert(taskLists).values({
      userId,
      pageId,
      title: taskListPage.title,
      status: 'pending',
      metadata: {
        createdAt: new Date().toISOString(),
        autoCreated: true,
      },
    }).returning();
    taskList = newTaskList;
  }

  // Get next page position for the child document — the single ordering rail (#2143).
  const lastChildPage = await db.query.pages.findFirst({
    where: and(eq(pages.parentId, pageId), eq(pages.isTrashed, false)),
    orderBy: [desc(pages.position)],
  });
  const nextPagePosition = (lastChildPage?.position ?? 0) + 1;

  // A caller-supplied `position` is resolved against the current siblings up front
  // and applied to the insert directly, in the same transaction — not as a second
  // move afterward. A split commit (insert, then a separate move transaction) would
  // let a mid-flight failure leave a task the client sees as failed but that a retry
  // would then duplicate.
  const newTaskPageId = createId();
  let initialPagePosition = nextPagePosition;
  let densifyPlan: Extract<ReturnType<typeof computeTaskMovePosition>, { kind: 'densify' }> | undefined;
  if (typeof position === 'number') {
    const taskListPeers = await db
      .select({ id: pages.id, position: pages.position })
      .from(pages)
      .where(and(eq(pages.parentId, pageId), eq(pages.type, 'TASK_LIST'), eq(pages.isTrashed, false)));
    const plan = computeTaskMovePosition({ peers: taskListPeers, movedId: newTaskPageId, targetIndex: position });
    if (plan.kind === 'single') {
      initialPagePosition = plan.position;
    } else {
      densifyPlan = plan;
    }
  }

  // Validate assigneeAgentId if provided
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
      throw new Error('Invalid agent ID - must be an AI agent page');
    }

    if (agentPage.driveId !== taskListPage.driveId) {
      throw new Error('Agent must be in the same drive as the task list');
    }
  }

  // Validate custom status if provided
  const resolvedStatus = status || 'pending';
  // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
  const statusConfigsForList = await db.query.taskStatusConfigs.findMany({
    where: eq(taskStatusConfigs.taskListId, taskList!.id),
    columns: { slug: true, group: true },
  });
  if (statusConfigsForList.length > 0 && status) {
    const matched = statusConfigsForList.find(c => c.slug === status);
    if (!matched) {
      throw new Error(`Invalid status "${status}". Valid: ${statusConfigsForList.map(c => c.slug).join(', ')}`);
    }
  }

  // Create task list page and task in transaction
  const result = await db.transaction(async (tx) => {
    // Create task list page (description + sub-tasks live here)
    const [taskPage] = await tx.insert(pages).values({
      id: newTaskPageId,
      title: trimmedTitle,
      type: 'TASK_LIST',
      parentId: pageId,
      driveId: taskListPage.driveId,
      content: '',
      position: initialPagePosition,
      updatedAt: new Date(),
    }).returning();

    // Create task with link to the page
    const primaryUserId = assigneeId || (assigneeIds?.find(a => a.type === 'user')?.id) || null;
    const primaryAgentId = assigneeAgentId || (assigneeIds?.find(a => a.type === 'agent')?.id) || null;

    const [newTask] = await tx.insert(taskItems).values({
      userId,
      pageId: taskPage.id,
      status: resolvedStatus,
      priority: priority || 'medium',
      assigneeId: primaryUserId,
      assigneeAgentId: primaryAgentId,
      dueDate: dueDate ? new Date(dueDate) : null,
      metadata: {
        createdAt: new Date().toISOString(),
        note,
      },
    }).returning();

    // Create multiple assignees in junction table
    const assigneeRows: { taskId: string; userId?: string; agentPageId?: string }[] = [];
    if (assigneeIds && assigneeIds.length > 0) {
      for (const a of assigneeIds) {
        if (a.type === 'user') assigneeRows.push({ taskId: newTask.id, userId: a.id });
        else if (a.type === 'agent') assigneeRows.push({ taskId: newTask.id, agentPageId: a.id });
      }
    } else {
      if (primaryUserId) assigneeRows.push({ taskId: newTask.id, userId: primaryUserId });
      if (primaryAgentId) assigneeRows.push({ taskId: newTask.id, agentPageId: primaryAgentId });
    }
    if (assigneeRows.length > 0) {
      await tx.insert(taskAssignees).values(assigneeRows);
    }

    // Create agent trigger workflow if requested
    if (agentTrigger) {
      if (!taskListPage.driveId) {
        throw new Error('Agent triggers require a drive-based task list');
      }
      await createTaskTriggerWorkflow({
        database: tx,
        driveId: taskListPage.driveId,
        userId,
        taskId: newTask.id,
        taskMetadata: newTask.metadata as Record<string, unknown> | null,
        agentTrigger,
        dueDate: dueDate ? new Date(dueDate) : null,
        timezone: context.timezone || 'UTC',
      });
    }

    // A densify plan (the float4 gap between the target slot's neighbours could no
    // longer be split) re-derives every sibling's position in the same transaction
    // as the insert, so the whole placement — new row included — commits atomically.
    if (densifyPlan) {
      await reorderTaskListChildPages(tx, pageId, computeReorderPlan([...densifyPlan.positions]));
    }

    return { task: newTask, page: taskPage };
  });

  const createdPage = result.page;
  const resultTitle = createdPage.title;

  // Densify overwrote the insert's position for every sibling including the new
  // page; everything else already landed on `initialPagePosition` at insert time.
  const resultPosition = densifyPlan
    ? densifyPlan.positions.find(p => p.id === newTaskPageId)?.position ?? createdPage.position
    : createdPage.position;

  const resultTask = { ...result.task, position: resultPosition };

  // Broadcast creation events
  await Promise.all([
    broadcastTaskEvent({
      type: 'task_added',
      taskId: resultTask.id,
      taskListId: taskList.id,
      userId,
      pageId,
      data: { title: resultTitle, priority: resultTask.priority, pageId: createdPage.id },
    }),
    broadcastPageEvent(
      createPageEventPayload(taskListPage.driveId, createdPage.id, 'created', {
        parentId: pageId,
        title: resultTitle,
        type: 'TASK_LIST',
      }),
    ),
  ]);

  // Log activity for AI-generated task/page creation
  const aiContext = await getAiContextWithActor(context);
  logPageActivity(userId, 'create', {
    id: createdPage.id,
    title: resultTitle,
    driveId: taskListPage.driveId,
  }, {
    ...aiContext,
    metadata: {
      ...aiContext.metadata,
      taskId: resultTask.id,
      taskTitle: resultTitle,
    },
  });

  return buildTaskListResponse({
    action: 'created',
    parentPageId: pageId,
    taskListId: taskList.id,
    resultTask,
    resultTitle,
    message: `Created task "${resultTitle}" with linked document page`,
  });
}

/**
 * Hard-delete a task and trash its linked TASK_LIST page.
 *
 * disableTaskTriggers MUST run before the taskItems delete: task_triggers has
 * ON DELETE CASCADE on taskItemId, so deleting the task first wipes the trigger
 * rows and the helper's SELECT returns empty, leaking orphan workflows rows.
 * Returns the refreshed list so client UIs drop the deleted task immediately.
 * Backs the delete_task tool.
 */
export async function deleteTask(
  context: ToolExecutionContext,
  userId: string,
  existingTask: TaskForUpdate,
  taskList: typeof taskLists.$inferSelect,
  reason: string,
) {
  const taskId = existingTask.id;
  const taskListPageId = taskList.pageId;
  const taskListId = taskList.id;
  const linkedPageId = existingTask.pageId;
  const existingTitle = existingTask.page?.title ?? '';
  const actorInfo = await getActorInfo(userId);

  await disableTaskTriggers(taskId, reason);

  // Trash linked TASK_LIST page and hard-delete the task row in one transaction.
  // taskAssignees rows cascade-delete via FK on taskItems.
  // applyPageMutation returns a deferredTrigger that callers passing their own tx
  // must invoke after commit so downstream workflows tied to page activity fire.
  let deferredTrigger: DeferredWorkflowTrigger | undefined;
  try {
    await db.transaction(async (tx) => {
      const [linkedPage] = await tx
        .select({ revision: pages.revision })
        .from(pages)
        .where(eq(pages.id, linkedPageId))
        .limit(1);

      if (linkedPage) {
        const mutationResult = await applyPageMutation({
          pageId: linkedPageId,
          operation: 'trash',
          updates: { isTrashed: true, trashedAt: new Date() },
          updatedFields: ['isTrashed', 'trashedAt'],
          expectedRevision: linkedPage.revision,
          context: {
            userId,
            actorEmail: actorInfo.actorEmail,
            actorDisplayName: actorInfo.actorDisplayName ?? undefined,
            isAiGenerated: true,
            aiProvider: context.aiProvider,
            aiModel: context.aiModel,
            aiConversationId: context.conversationId,
            metadata: {
              taskId,
              taskListId,
              taskListPageId,
            },
          },
          tx,
        });
        deferredTrigger = mutationResult.deferredTrigger;
      }

      await tx.delete(taskItems).where(eq(taskItems.id, taskId));
    });
    deferredTrigger?.();
  } catch (error) {
    if (error instanceof PageRevisionMismatchError) {
      throw new Error(`Linked page was modified concurrently — retry the delete: ${error.message}`);
    }
    throw error;
  }

  // Look up driveId for the page-trashed broadcast (best-effort)
  let deletedDriveId: string | undefined;
  if (taskListPageId) {
    const taskListPage = await db.query.pages.findFirst({
      where: eq(pages.id, taskListPageId),
      columns: { driveId: true },
    });
    deletedDriveId = taskListPage?.driveId;
  }

  const broadcasts: Promise<void>[] = [
    broadcastTaskEvent({
      type: 'task_deleted',
      taskId,
      taskListId,
      userId,
      pageId: taskListPageId || undefined,
      data: { id: taskId, title: existingTitle },
    }),
  ];
  if (deletedDriveId) {
    broadcasts.push(
      broadcastPageEvent(
        createPageEventPayload(deletedDriveId, linkedPageId, 'trashed', {
          title: existingTitle,
          parentId: taskListPageId || undefined,
        }),
      ),
    );
  }
  await Promise.all(broadcasts);

  // Return the refreshed task list + remaining tasks so client UIs
  // (e.g. useAggregatedTasks → TasksDropdown) can drop the deleted
  // task immediately instead of waiting for a subsequent tool call.
  const remainingTasks = await fetchEnrichedTasks(taskList.pageId!);
  const refreshedTaskList = await db.query.taskLists.findFirst({
    where: eq(taskLists.id, taskListId),
  });

  return {
    success: true,
    action: 'deleted' as const,
    task: {
      id: existingTask.id,
      title: existingTitle,
      pageId: linkedPageId,
    },
    taskList: serializeTaskList(refreshedTaskList, deletedDriveId),
    tasks: remainingTasks.map(serializeTaskItem),
    message: `Deleted task "${existingTitle}" and trashed its linked page`,
  };
}

/** Actor attribution for a task move, forwarded to applyPageMutation. */
export interface TaskReorderActor {
  userId: string;
  isAiGenerated?: boolean;
  aiProvider?: string;
  aiModel?: string;
  aiConversationId?: string;
}

/**
 * Move a task to slot `position` within its list. Returns the clamped index
 * actually assigned. Backs the reorder_task tool and the REST
 * `PATCH /tasks/[taskId] {position}` field.
 *
 * The write lands on `pages.position` of the task's linked page — the single
 * ordering rail. This used to re-densify a separate `task_items.position` that
 * nothing user-facing read, so the tool reported success while the list the user
 * saw never changed (#2143).
 *
 * The common case writes one page through applyPageMutation, exactly like a user
 * drag (`PATCH /api/pages/reorder`), so the move gets the same revision bump,
 * activity log and deferred workflow trigger. When the float4 gap between the
 * target's neighbours can no longer be split, the plan escalates to re-densifying
 * the whole list in one batched write instead.
 *
 * Returns both the clamped slot (what the caller asked for, in index terms) and
 * the `pages.position` actually written — they differ whenever positions are
 * fractional, and responses need the latter to stay consistent with the task list
 * they are served alongside.
 */
export async function reorderTaskPeers(
  taskListPageId: string,
  taskId: string,
  position: number,
  actor: TaskReorderActor,
): Promise<{ index: number; position: number }> {
  const task = await db.query.taskItems.findFirst({
    where: eq(taskItems.id, taskId),
    columns: { pageId: true },
  });

  if (!task?.pageId) {
    throw new Error('Task not found');
  }

  const peers = await db
    .select({ id: pages.id, position: pages.position, revision: pages.revision })
    .from(pages)
    .where(and(
      eq(pages.parentId, taskListPageId),
      eq(pages.type, 'TASK_LIST'),
      eq(pages.isTrashed, false),
    ))
    .orderBy(asc(pages.position), asc(pages.id));

  const plan = computeTaskMovePosition({
    peers: peers.map(p => ({ id: p.id, position: p.position })),
    movedId: task.pageId,
    targetIndex: position,
  });

  if (plan.kind === 'densify') {
    await db.transaction(async (tx) => {
      await reorderTaskListChildPages(tx, taskListPageId, computeReorderPlan([...plan.positions]));
    });
    // Densified positions are 0..n-1, so the slot and the stored position coincide.
    return { index: plan.index, position: plan.index };
  }

  const actorInfo = await getActorInfo(actor.userId);
  let deferredTrigger: DeferredWorkflowTrigger | undefined;
  await db.transaction(async (tx) => {
    const mutationResult = await applyPageMutation({
      pageId: task.pageId,
      operation: 'move',
      updates: { position: plan.position },
      updatedFields: ['position'],
      expectedRevision: peers.find(p => p.id === task.pageId)?.revision,
      context: {
        userId: actor.userId,
        actorEmail: actorInfo.actorEmail,
        actorDisplayName: actorInfo.actorDisplayName ?? undefined,
        isAiGenerated: actor.isAiGenerated,
        aiProvider: actor.aiProvider,
        aiModel: actor.aiModel,
        aiConversationId: actor.aiConversationId,
        metadata: { taskId, taskListPageId },
      },
      tx,
    });
    deferredTrigger = mutationResult.deferredTrigger;
  });
  deferredTrigger?.();

  return { index: plan.index, position: plan.position };
}
