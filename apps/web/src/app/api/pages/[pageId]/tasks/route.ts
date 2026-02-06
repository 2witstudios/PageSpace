import { NextResponse } from 'next/server';
import { db, taskLists, taskItems, taskStatusConfigs, taskAssignees, pages, eq, and, desc, asc } from '@pagespace/db';
import { DEFAULT_TASK_STATUSES } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage, canUserEditPage } from '@pagespace/lib/server';
import { broadcastTaskEvent, broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { getDefaultContent, PageType } from '@pagespace/lib';
import { getActorInfo, logPageActivity } from '@pagespace/lib/monitoring/activity-logger';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

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

  // Check view permission
  const canView = await canUserViewPage(userId, pageId);
  if (!canView) {
    return NextResponse.json({
      error: 'You need view permission to access this task list',
    }, { status: 403 });
  }

  // Get or create task list (also ensures default status configs)
  const taskList = await getOrCreateTaskListForPage(pageId, userId);

  // Parse query params for filtering
  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const assigneeId = url.searchParams.get('assigneeId');
  const search = url.searchParams.get('search');
  const sortOrder = url.searchParams.get('sortOrder') || 'asc';

  // Fetch status configs for this task list
  const statusConfigs = await db.query.taskStatusConfigs.findMany({
    where: eq(taskStatusConfigs.taskListId, taskList.id),
    orderBy: [asc(taskStatusConfigs.position)],
  });

  // Build query - include assignees relation
  const query = db.query.taskItems.findMany({
    where: and(
      eq(taskItems.taskListId, taskList.id),
      status ? eq(taskItems.status, status) : undefined,
      assigneeId ? eq(taskItems.assigneeId, assigneeId) : undefined,
    ),
    columns: {
      id: true,
      taskListId: true,
      userId: true,
      assigneeId: true,
      assigneeAgentId: true,
      pageId: true,
      title: true,
      description: true,
      status: true,
      priority: true,
      position: true,
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
          isTrashed: true,
          position: true,
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

  let tasks = await query;

  // Filter out tasks whose pages are trashed
  tasks = tasks.filter(task => !task.page?.isTrashed);

  // Sort by page.position (source of truth), fallback to task.position
  tasks.sort((a, b) => {
    const posA = a.page?.position ?? a.position;
    const posB = b.page?.position ?? b.position;
    return sortOrder === 'desc' ? posB - posA : posA - posB;
  });

  // Apply search filter in memory
  if (search) {
    const searchLower = search.toLowerCase();
    tasks = tasks.filter(task =>
      task.title.toLowerCase().includes(searchLower) ||
      (task.description?.toLowerCase().includes(searchLower))
    );
  }

  return NextResponse.json({
    taskList: {
      id: taskList.id,
      title: taskList.title,
      description: taskList.description,
      status: taskList.status,
      updatedAt: taskList.updatedAt,
    },
    tasks,
    statusConfigs,
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

  // Check edit permission
  const canEdit = await canUserEditPage(userId, pageId);
  if (!canEdit) {
    return NextResponse.json({
      error: 'You need edit permission to add tasks',
    }, { status: 403 });
  }

  const body = await req.json();
  const {
    title,
    description,
    status,
    priority,
    assigneeId,
    assigneeAgentId,
    assigneeIds,
    dueDate,
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

  // Get or create task list
  const taskList = await getOrCreateTaskListForPage(pageId, userId);

  // Validate status against task list's status configs
  if (status) {
    const validStatuses = await db.query.taskStatusConfigs.findMany({
      where: eq(taskStatusConfigs.taskListId, taskList.id),
      columns: { slug: true },
    });
    const validSlugs = validStatuses.map(s => s.slug);
    if (validSlugs.length > 0 && !validSlugs.includes(status)) {
      return NextResponse.json({ error: `Invalid status "${status}". Valid statuses: ${validSlugs.join(', ')}` }, { status: 400 });
    }
  }

  // Get highest position for new task and new page
  const [lastTask, lastChildPage] = await Promise.all([
    db.query.taskItems.findFirst({
      where: eq(taskItems.taskListId, taskList.id),
      orderBy: [desc(taskItems.position)],
    }),
    db.query.pages.findFirst({
      where: and(eq(pages.parentId, pageId), eq(pages.isTrashed, false)),
      orderBy: [desc(pages.position)],
    }),
  ]);

  const nextTaskPosition = (lastTask?.position ?? -1) + 1;
  const nextPagePosition = (lastChildPage?.position ?? 0) + 1;

  // Determine primary assignee for backward compat fields (derive from assigneeIds if present)
  const primaryAssigneeId = assigneeId || assigneeIds?.find((a: { type: string }) => a.type === 'user')?.id || null;
  const primaryAgentId = assigneeAgentId || assigneeIds?.find((a: { type: string }) => a.type === 'agent')?.id || null;

  // Create task and its document page in a transaction
  const result = await db.transaction(async (tx) => {
    // Create document page for the task
    const [taskPage] = await tx.insert(pages).values({
      title: title.trim(),
      type: 'DOCUMENT',
      parentId: pageId,
      driveId: taskListPage.driveId,
      content: getDefaultContent(PageType.DOCUMENT),
      position: nextPagePosition,
      updatedAt: new Date(),
    }).returning();

    // Create task with link to the page
    const [newTask] = await tx.insert(taskItems).values({
      taskListId: taskList.id,
      userId,
      pageId: taskPage.id,
      title: title.trim(),
      description: description?.trim() || null,
      status: status || 'pending',
      priority: priority || 'medium',
      assigneeId: primaryAssigneeId,
      assigneeAgentId: primaryAgentId,
      dueDate: dueDate ? new Date(dueDate) : null,
      position: nextTaskPosition,
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

    return { task: newTask, page: taskPage };
  });

  // Fetch task with relations (including assignees)
  const taskWithRelations = await db.query.taskItems.findFirst({
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

  // Broadcast events
  await Promise.all([
    broadcastTaskEvent({
      type: 'task_added',
      taskId: result.task.id,
      taskListId: taskList.id,
      userId,
      pageId,
      data: {
        title: result.task.title,
        priority: result.task.priority,
        pageId: result.page.id,
      },
    }),
    broadcastPageEvent(
      createPageEventPayload(taskListPage.driveId, result.page.id, 'created', {
        parentId: pageId,
        title: result.task.title,
        type: 'DOCUMENT',
      }),
    ),
  ]);

  // Log task creation for compliance (fire-and-forget)
  const actorInfo = await getActorInfo(userId);
  logPageActivity(userId, 'create', {
    id: result.page.id,
    title: result.task.title,
    driveId: taskListPage.driveId,
  }, {
    ...actorInfo,
    metadata: {
      taskId: result.task.id,
      taskListId: taskList.id,
      taskListPageId: pageId,
    },
  });

  return NextResponse.json({
    ...taskWithRelations,
    pageId: result.page.id,
  }, { status: 201 });
}
