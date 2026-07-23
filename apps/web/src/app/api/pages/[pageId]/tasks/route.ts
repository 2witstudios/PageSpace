import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq, and, desc, asc, inArray, count, isNotNull, ilike } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { taskLists, taskItems, taskStatusConfigs, taskAssignees } from '@pagespace/db/schema/tasks';
import { taskTriggers } from '@pagespace/db/schema/task-triggers';
import { createTaskTriggerWorkflow, type TaskTriggerWorkflowResult } from '@/lib/workflows/task-trigger-helpers';
import { DEFAULT_TASK_STATUSES } from '@pagespace/db/schema/tasks';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { canPrincipalViewPage, canPrincipalEditPage } from '@/lib/auth'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { broadcastTaskEvent, broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { getActorInfo, logPageActivity } from '@pagespace/lib/monitoring/activity-logger';
import { createTaskAssignedNotification } from '@pagespace/lib/notifications/notifications';
import { computeHasContent } from './task-utils';
import { backfillMissingTaskItems } from '@/services/api/task-sync-service';
import { compareByPagePosition } from '@/services/api/task-ordering';
import { reorderTaskPeers } from '@/lib/ai/tools/task-helpers';
import { getUserTimezone } from '@/lib/ai/core/personalization-utils';
import { decryptTaskUserRelations, decryptTaskUserRelationsOne } from '@/lib/tasks/decrypt-task-relations';
import { escapeLikePattern } from '@pagespace/lib/db/like-pattern';
import { parseTaskQuerySpec } from './query-spec';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

/**
 * Get or create task list for a page, ensuring default status configs exist
 */
async function getOrCreateTaskListForPage(pageId: string, userId: string) {
  // Check if task list exists for this page
  let taskList = await db.query.taskLists.findFirst({
    where: eq(taskLists.pageId, pageId),
  });

  // If not, create one with default status configs
  if (!taskList) {
    taskList = await db.transaction(async (tx) => {
      const [created] = await tx.insert(taskLists).values({
        userId,
        pageId,
        title: 'Task List',
        status: 'pending',
      }).returning();

      // Create default status configs
      await tx.insert(taskStatusConfigs).values(
        DEFAULT_TASK_STATUSES.map(s => ({
          taskListId: created.id,
          ...s,
        }))
      );

      return created;
    });
  } else {
    // Ensure status configs exist for existing task lists (migration path)
    // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
    const existingConfigs = await db.query.taskStatusConfigs.findMany({
      where: eq(taskStatusConfigs.taskListId, taskList.id),
    });

    if (existingConfigs.length === 0) {
      try {
        await db.insert(taskStatusConfigs).values(
          DEFAULT_TASK_STATUSES.map(s => ({
            taskListId: taskList!.id,
            ...s,
          }))
        );
      } catch (error) {
        // Swallow duplicate key errors from concurrent requests
        const message = error instanceof Error ? error.message : '';
        if (!message.includes('unique') && !message.includes('duplicate')) {
          throw error;
        }
      }
    }
  }

  return taskList;
}

/**
 * GET /api/pages/[pageId]/tasks
 * Fetch all tasks for a TASK_LIST page, including status configs and assignees
 */
export async function GET(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  // Check MCP page scope
  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  // Check view permission
  const canView = await canPrincipalViewPage(auth, pageId);
  if (!canView) {
    return NextResponse.json({
      error: 'You need view permission to access this task list',
    }, { status: 403 });
  }

  // Get or create task list (also ensures default status configs)
  const taskList = await getOrCreateTaskListForPage(pageId, userId);

  // Parse query params for filtering + pagination bounds
  const url = new URL(req.url);
  const { status, assigneeId, search, sortOrder, limit, offset } = parseTaskQuerySpec(url.searchParams);

  // Fetch status configs for this task list
  // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
  const statusConfigs = await db.query.taskStatusConfigs.findMany({
    where: eq(taskStatusConfigs.taskListId, taskList.id),
    orderBy: [asc(taskStatusConfigs.position)],
  });

  // Derive tasks from pages that are direct TASK_LIST children of this page
  const childPages = await db
    .select({ id: pages.id })
    .from(pages)
    .where(and(
      eq(pages.parentId, pageId),
      eq(pages.type, 'TASK_LIST'),
      eq(pages.isTrashed, false),
    ));
  const childPageIds = childPages.map(p => p.id);

  const emptyTasksResponse = () => NextResponse.json({
    taskList: {
      id: taskList.id,
      title: taskList.title,
      description: taskList.description,
      status: taskList.status,
      updatedAt: taskList.updatedAt,
    },
    tasks: [],
    statusConfigs,
    hasMore: false,
  });

  if (childPageIds.length === 0) {
    return emptyTasksResponse();
  }

  // Self-heal: any TASK_LIST child missing its task_items row (created or moved via a
  // path that skipped the sync) gets backfilled here so it always shows up as a task.
  await backfillMissingTaskItems(db, { parentId: pageId, childPageIds, userId });

  // Phase 1: a lightweight join resolves the ordered (by pages.position, the single
  // ordering rail — #2143), filtered, bounded set of task ids — this is what keeps
  // the query from pulling every task into memory (the OOM crash this route caused).
  // Phase 2 hydrates only those ids' relations.
  // Requesting limit+1 rows and slicing lets the response report `hasMore` (for the
  // frontend's Load More) without a separate COUNT(*) query.
  const positionExpr = pages.position;
  const orderedIdRows = await db
    .select({ id: taskItems.id })
    .from(taskItems)
    .innerJoin(pages, eq(pages.id, taskItems.pageId))
    .where(and(
      inArray(taskItems.pageId, childPageIds),
      status ? eq(taskItems.status, status) : undefined,
      assigneeId ? eq(taskItems.assigneeId, assigneeId) : undefined,
      search ? ilike(pages.title, `%${escapeLikePattern(search)}%`) : undefined,
    ))
    // taskItems.id is a tiebreaker, not a sort key the user chose: without it, two tasks
    // sharing a position (e.g. a read-then-write race in POST's nextPosition, or backfilled
    // pages that never got a distinct one) have no guaranteed stable order across repeated
    // LIMIT/OFFSET calls, so paging (offset=0, then offset=100) can skip or duplicate rows.
    .orderBy(sortOrder === 'desc' ? desc(positionExpr) : asc(positionExpr), asc(taskItems.id))
    .limit(limit + 1)
    .offset(offset);
  const hasMore = orderedIdRows.length > limit;
  const boundedTaskIds = orderedIdRows.slice(0, limit).map(r => r.id);

  if (boundedTaskIds.length === 0) {
    return emptyTasksResponse();
  }

  // Phase 2: hydrate the 5 relations only for the bounded page of ids from phase 1.
  // The explicit `limit` is redundant with `boundedTaskIds` already being capped at phase 1
  // — kept as defense-in-depth so this call stays bounded even if that invariant is ever
  // broken upstream, and so it stays self-evidently bounded to a lint rule scanning for one.
  const query = db.query.taskItems.findMany({
    where: inArray(taskItems.id, boundedTaskIds),
    limit: boundedTaskIds.length,
    columns: {
      id: true,
      userId: true,
      assigneeId: true,
      assigneeAgentId: true,
      pageId: true,
      status: true,
      priority: true,
      dueDate: true,
      metadata: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
    },
    with: {
      assignee: {
        columns: {
          id: true,
          name: true,
          image: true,
        },
      },
      assigneeAgent: {
        columns: {
          id: true,
          title: true,
          type: true,
        },
      },
      user: {
        columns: {
          id: true,
          name: true,
          image: true,
        },
      },
      page: {
        columns: {
          id: true,
          title: true,
          type: true,
          isTrashed: true,
          position: true,
          content: true,
        },
      },
      assignees: {
        with: {
          user: {
            columns: {
              id: true,
              name: true,
              image: true,
            },
          },
          agentPage: {
            columns: {
              id: true,
              title: true,
              type: true,
            },
          },
        },
      },
    },
  });

  const tasks = await decryptTaskUserRelations(await query);

  // Phase 2's `inArray` hydration does not preserve phase 1's order, so re-apply it
  // here against the same rail and the same id tiebreaker.
  tasks.sort((a, b) => compareByPagePosition(a, b, sortOrder));

  // Ground-truth active trigger count from task_triggers so badges don't go
  // stale when an agent page is trashed: the workflows row cascade-deletes,
  // which in turn cascade-deletes the task_triggers row.
  const triggerCountByTaskId = new Map<string, number>();
  if (tasks.length > 0) {
    const taskIdList = tasks.map((t) => t.id);
    const triggerRows = await db
      .select({ taskItemId: taskTriggers.taskItemId, total: count() })
      .from(taskTriggers)
      .where(and(
        inArray(taskTriggers.taskItemId, taskIdList),
        eq(taskTriggers.isEnabled, true),
      ))
      .groupBy(taskTriggers.taskItemId);
    for (const row of triggerRows) {
      triggerCountByTaskId.set(row.taskItemId, Number(row.total));
    }
  }

  // Batch-count sub-tasks (total + completed) for each task's linked page via pages.parentId
  const subTaskCountByPageId = new Map<string, number>();
  const subTaskCompletedByPageId = new Map<string, number>();
  const linkedPageIds = tasks.map(t => t.pageId).filter((id): id is string => !!id);
  if (linkedPageIds.length > 0) {
    const baseWhere = and(inArray(pages.parentId, linkedPageIds), eq(pages.isTrashed, false));
    const [subTaskRows, completedSubTaskRows] = await Promise.all([
      db
        .select({ parentId: pages.parentId, total: count() })
        .from(taskItems)
        .innerJoin(pages, eq(pages.id, taskItems.pageId))
        .where(baseWhere)
        .groupBy(pages.parentId),
      db
        .select({ parentId: pages.parentId, total: count() })
        .from(taskItems)
        .innerJoin(pages, eq(pages.id, taskItems.pageId))
        .where(and(baseWhere, isNotNull(taskItems.completedAt)))
        .groupBy(pages.parentId),
    ]);
    for (const row of subTaskRows) {
      if (row.parentId) subTaskCountByPageId.set(row.parentId, Number(row.total));
    }
    for (const row of completedSubTaskRows) {
      if (row.parentId) subTaskCompletedByPageId.set(row.parentId, Number(row.total));
    }
  }

  const enrichedTasks = tasks.map(({ page, ...t }) => ({
    ...t,
    // Sourced from the linked page — the single ordering rail (#2143).
    position: page?.position ?? 0,
    title: page?.title ?? '',
    activeTriggerCount: triggerCountByTaskId.get(t.id) ?? 0,
    hasContent: computeHasContent(page?.content),
    subTaskCount: subTaskCountByPageId.get(t.pageId ?? '') ?? 0,
    subTaskCompletedCount: subTaskCompletedByPageId.get(t.pageId ?? '') ?? 0,
    page: page ? { id: page.id, type: page.type, isTrashed: page.isTrashed, position: page.position } : null,
  }));

  return NextResponse.json({
    taskList: {
      id: taskList.id,
      title: taskList.title,
      description: taskList.description,
      status: taskList.status,
      updatedAt: taskList.updatedAt,
    },
    tasks: enrichedTasks,
    statusConfigs,
    hasMore,
  });
}

/**
 * POST /api/pages/[pageId]/tasks
 * Create a new task with an auto-created document page
 * Supports multiple assignees via assigneeIds array
 */
export async function POST(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  // Check MCP page scope
  const writeScopeError = await checkMCPPageScope(auth, pageId);
  if (writeScopeError) return writeScopeError;

  // Check edit permission
  const canEdit = await canPrincipalEditPage(auth, pageId);
  if (!canEdit) {
    return NextResponse.json({
      error: 'You need edit permission to add tasks',
    }, { status: 403 });
  }

  const body = await req.json();
  const {
    title,
    status,
    priority,
    assigneeId,
    assigneeAgentId,
    assigneeIds,
    dueDate,
    note,
    position,
    timezone,
    agentTrigger,
  } = body;

  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return NextResponse.json({ error: 'Title is required' }, { status: 400 });
  }

  // Get the task list page to find its driveId
  const taskListPage = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
    columns: { id: true, driveId: true },
  });

  if (!taskListPage) {
    return NextResponse.json({ error: 'Task list page not found' }, { status: 404 });
  }

  // Validate assigneeAgentId if provided (legacy single agent)
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

    if (agentPage.driveId !== taskListPage.driveId) {
      return NextResponse.json({ error: 'Agent must be in the same drive as the task list' }, { status: 400 });
    }
  }

  // Validate agent trigger shape (business logic validation done by createTaskTriggerWorkflow)
  if (agentTrigger) {
    if (!taskListPage.driveId) {
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
    if (triggerType === 'due_date' && !dueDate) {
      return NextResponse.json({ error: 'Due date is required for due_date triggers' }, { status: 400 });
    }
    if (agentTrigger.contextPageIds && (!Array.isArray(agentTrigger.contextPageIds) || agentTrigger.contextPageIds.length > 10)) {
      return NextResponse.json({ error: 'contextPageIds must be an array of at most 10 page IDs' }, { status: 400 });
    }
    // Normalize triggerType for downstream
    agentTrigger.triggerType = triggerType;
  }

  // Get or create task list
  const taskList = await getOrCreateTaskListForPage(pageId, userId);

  // Validate status against task list's status configs
  let initialCompletedAt: Date | null = null;
  if (status) {
    // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
    const validStatuses = await db.query.taskStatusConfigs.findMany({
      where: eq(taskStatusConfigs.taskListId, taskList.id),
      columns: { slug: true, group: true },
    });
    const validSlugs = validStatuses.map(s => s.slug);
    if (validSlugs.length > 0 && !validSlugs.includes(status)) {
      return NextResponse.json({ error: `Invalid status "${status}". Valid statuses: ${validSlugs.join(', ')}` }, { status: 400 });
    }
    const matchedConfig = validStatuses.find(s => s.slug === status);
    if (matchedConfig?.group === 'done' || (!matchedConfig && status === 'completed')) {
      initialCompletedAt = new Date();
    }
  }

  // Get highest position for the new page. `pages.position` is the single ordering
  // rail (#2143): a caller-supplied `position` is applied after creation via
  // reorderTaskPeers, so creation and reordering share one placement path.
  const lastChildPage = await db.query.pages.findFirst({
    where: and(eq(pages.parentId, pageId), eq(pages.isTrashed, false)),
    orderBy: [desc(pages.position)],
  });

  const nextPosition = (lastChildPage?.position ?? 0) + 1;

  // Determine primary assignee for backward compat fields (derive from assigneeIds if present)
  const primaryAssigneeId = assigneeId || assigneeIds?.find((a: { type: string }) => a.type === 'user')?.id || null;
  const primaryAgentId = assigneeAgentId || assigneeIds?.find((a: { type: string }) => a.type === 'agent')?.id || null;

  // Resolve the trigger timezone once, up front: explicit body value wins, else
  // the caller's profile timezone, else UTC — matching the internal create_task tool.
  const resolvedTimezone = agentTrigger
    ? (typeof timezone === 'string' && timezone.trim() ? timezone.trim() : (await getUserTimezone(userId)) || 'UTC')
    : 'UTC';

  // Create task and its document page in a transaction
  const result = await db.transaction(async (tx) => {
    // Create task list page (description + sub-tasks live here)
    const [taskPage] = await tx.insert(pages).values({
      title: title.trim(),
      type: 'TASK_LIST',
      parentId: pageId,
      driveId: taskListPage.driveId,
      content: '',
      position: nextPosition,
      updatedAt: new Date(),
    }).returning();

    // Create task metadata — list membership is derived from pages.parentId
    const [newTask] = await tx.insert(taskItems).values({
      userId,
      pageId: taskPage.id,
      status: status || 'pending',
      priority: priority || 'medium',
      assigneeId: primaryAssigneeId,
      assigneeAgentId: primaryAgentId,
      dueDate: dueDate ? new Date(dueDate) : null,
      completedAt: initialCompletedAt,
      metadata: {
        createdAt: new Date().toISOString(),
        note,
      },
    }).returning();

    // Create assignees in junction table
    const assigneeRows: { taskId: string; userId?: string; agentPageId?: string }[] = [];

    // Handle new assigneeIds array (format: [{ type: 'user'|'agent', id: string }])
    if (Array.isArray(assigneeIds) && assigneeIds.length > 0) {
      for (const entry of assigneeIds) {
        if (entry.type === 'user' && entry.id) {
          assigneeRows.push({ taskId: newTask.id, userId: entry.id });
        } else if (entry.type === 'agent' && entry.id) {
          assigneeRows.push({ taskId: newTask.id, agentPageId: entry.id });
        }
      }
    } else {
      // Backward compat: populate junction table from legacy single-assignee fields
      if (primaryAssigneeId) {
        assigneeRows.push({ taskId: newTask.id, userId: primaryAssigneeId });
      }
      if (primaryAgentId) {
        assigneeRows.push({ taskId: newTask.id, agentPageId: primaryAgentId });
      }
    }

    if (assigneeRows.length > 0) {
      await tx.insert(taskAssignees).values(assigneeRows);
    }

    // Create agent trigger workflow if requested
    let agentTriggerResult: TaskTriggerWorkflowResult | undefined;
    if (agentTrigger && taskListPage.driveId) {
      agentTriggerResult = await createTaskTriggerWorkflow({
        database: tx,
        driveId: taskListPage.driveId,
        userId,
        taskId: newTask.id,
        taskMetadata: newTask.metadata as Record<string, unknown> | null,
        agentTrigger,
        dueDate: dueDate ? new Date(dueDate) : null,
        timezone: resolvedTimezone,
      });
    }

    return { task: newTask, page: taskPage, agentTriggerResult };
  });

  // An explicit slot moves the created page onto that slot, so a REST-supplied
  // `position` writes the same rail a user drag does.
  let createdPosition = result.page.position;
  if (typeof position === 'number') {
    const moved = await reorderTaskPeers(pageId, result.task.id, position, { userId });
    createdPosition = moved.position;
  }

  // Fetch task with relations (including assignees)
  const fetchedTask = await db.query.taskItems.findFirst({
    where: eq(taskItems.id, result.task.id),
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
  const taskWithRelations = await decryptTaskUserRelationsOne(fetchedTask);

  const createdTitle = result.page.title;

  // Notify newly assigned users (self-assign guard is inside createTaskAssignedNotification)
  const assignedUserIds = (taskWithRelations?.assignees ?? [])
    .map(a => a.userId)
    .filter((id): id is string => !!id);
  for (const assignedUserId of assignedUserIds) {
    void createTaskAssignedNotification(
      assignedUserId,
      result.task.id,
      createdTitle,
      pageId,
      userId
    );
  }

  // Broadcast events
  await Promise.all([
    broadcastTaskEvent({
      type: 'task_added',
      taskId: result.task.id,
      taskListId: taskList.id,
      userId,
      pageId,
      data: {
        title: createdTitle,
        priority: result.task.priority,
        pageId: result.page.id,
      },
    }),
    broadcastPageEvent(
      createPageEventPayload(taskListPage.driveId, result.page.id, 'created', {
        parentId: pageId,
        title: createdTitle,
        type: 'TASK_LIST',
      }),
    ),
  ]);

  // Log task creation for compliance (fire-and-forget)
  const actorInfo = await getActorInfo(userId);
  logPageActivity(userId, 'create', {
    id: result.page.id,
    title: createdTitle,
    driveId: taskListPage.driveId,
  }, {
    ...actorInfo,
    metadata: {
      taskId: result.task.id,
      taskListId: taskList.id,
      taskListPageId: pageId,
    },
  });

  auditRequest(req, { eventType: 'data.write', userId, resourceType: 'task', resourceId: result.task.id, details: { pageId } });

  return NextResponse.json({
    ...taskWithRelations,
    position: createdPosition,
    title: createdTitle,
    pageId: result.page.id,
    ...(result.agentTriggerResult ? { agentTrigger: result.agentTriggerResult } : {}),
  }, { status: 201 });
}
