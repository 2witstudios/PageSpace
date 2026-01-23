import { NextResponse } from 'next/server';
import { db, taskLists, taskItems, pages, eq, and, desc } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage, canUserEditPage } from '@pagespace/lib/server';
import { broadcastTaskEvent, broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { getDefaultContent, PageType } from '@pagespace/lib';
import { getActorInfo, logPageActivity } from '@pagespace/lib/monitoring/activity-logger';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

/**
 * Get or create task list for a page
 */
async function getOrCreateTaskListForPage(pageId: string, userId: string) {
  // Check if task list exists for this page
  let taskList = await db.query.taskLists.findFirst({
    where: eq(taskLists.pageId, pageId),
  });

  // If not, create one
  if (!taskList) {
    const [created] = await db.insert(taskLists).values({
      userId,
      pageId,
      title: 'Task List',
      status: 'pending',
    }).returning();
    taskList = created;
  }

  return taskList;
}

/**
 * GET /api/pages/[pageId]/tasks
 * Fetch all tasks for a TASK_LIST page
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

  // Get or create task list
  const taskList = await getOrCreateTaskListForPage(pageId, userId);

  // Parse query params for filtering
  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const assigneeId = url.searchParams.get('assigneeId');
  const search = url.searchParams.get('search');
  const sortOrder = url.searchParams.get('sortOrder') || 'asc';

  // Build query - always sort by position for consistent ordering
  // Include pageId for navigation to task pages
  // Include page relation to filter out tasks with trashed pages
  const query = db.query.taskItems.findMany({
    where: and(
      eq(taskItems.taskListId, taskList.id),
      status ? eq(taskItems.status, status as 'pending' | 'in_progress' | 'completed' | 'blocked') : undefined,
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
    },
    // Note: We sort in memory below to handle page.position as source of truth
  });

  let tasks = await query;

  // Filter out tasks whose pages are trashed
  // Tasks without a pageId (conversation-based) are always included
  tasks = tasks.filter(task => !task.page?.isTrashed);

  // Sort by page.position (source of truth), fallback to task.position for conversation-based tasks
  tasks.sort((a, b) => {
    const posA = a.page?.position ?? a.position;
    const posB = b.page?.position ?? b.position;
    return sortOrder === 'desc' ? posB - posA : posA - posB;
  });

  // Apply search filter in memory (for title/description)
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
  });
}

/**
 * POST /api/pages/[pageId]/tasks
 * Create a new task with an auto-created document page
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
  const { title, description, status, priority, assigneeId, assigneeAgentId, dueDate } = body;

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
      return NextResponse.json({ error: 'Invalid agent ID - must be an AI agent page' }, { status: 400 });
    }

    if (agentPage.driveId !== taskListPage.driveId) {
      return NextResponse.json({ error: 'Agent must be in the same drive as the task list' }, { status: 400 });
    }
  }

  // Get or create task list
  const taskList = await getOrCreateTaskListForPage(pageId, userId);

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

  // Create task and its document page in a transaction
  const result = await db.transaction(async (tx) => {
    // Create document page for the task
    const [taskPage] = await tx.insert(pages).values({
      title: title.trim(),
      type: 'DOCUMENT',
      parentId: pageId, // Child of the task list page
      driveId: taskListPage.driveId,
      content: getDefaultContent(PageType.DOCUMENT),
      position: nextPagePosition,
      updatedAt: new Date(),
    }).returning();

    // Create task with link to the page
    const [newTask] = await tx.insert(taskItems).values({
      taskListId: taskList.id,
      userId,
      pageId: taskPage.id, // Link to the document page
      title: title.trim(),
      description: description?.trim() || null,
      status: status || 'pending',
      priority: priority || 'medium',
      assigneeId: assigneeId || null,
      assigneeAgentId: assigneeAgentId || null,
      dueDate: dueDate ? new Date(dueDate) : null,
      position: nextTaskPosition,
    }).returning();

    return { task: newTask, page: taskPage };
  });

  // Fetch task with relations
  const taskWithRelations = await db.query.taskItems.findFirst({
    where: eq(taskItems.id, result.task.id),
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
    },
  });

  // Broadcast events
  await Promise.all([
    // Broadcast task creation
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
    // Broadcast page creation for sidebar tree update
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
