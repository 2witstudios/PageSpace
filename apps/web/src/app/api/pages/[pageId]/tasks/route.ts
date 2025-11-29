import { NextResponse } from 'next/server';
import { db, taskLists, taskItems, eq, and, asc, desc } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage, canUserEditPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { createSignedBroadcastHeaders } from '@pagespace/lib/broadcast-auth';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

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

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
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
  const query = db.query.taskItems.findMany({
    where: and(
      eq(taskItems.taskListId, taskList.id),
      status ? eq(taskItems.status, status as 'pending' | 'in_progress' | 'completed' | 'blocked') : undefined,
      assigneeId ? eq(taskItems.assigneeId, assigneeId) : undefined,
    ),
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
    orderBy: sortOrder === 'desc'
      ? [desc(taskItems.position)]
      : [asc(taskItems.position)],
  });

  let tasks = await query;

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
    },
    tasks,
  });
}

/**
 * POST /api/pages/[pageId]/tasks
 * Create a new task
 */
export async function POST(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
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
  const { title, description, status, priority, assigneeId, dueDate } = body;

  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return NextResponse.json({ error: 'Title is required' }, { status: 400 });
  }

  // Get or create task list
  const taskList = await getOrCreateTaskListForPage(pageId, userId);

  // Get highest position for new task
  const lastTask = await db.query.taskItems.findFirst({
    where: eq(taskItems.taskListId, taskList.id),
    orderBy: [desc(taskItems.position)],
  });
  const nextPosition = (lastTask?.position ?? -1) + 1;

  // Create task
  const [newTask] = await db.insert(taskItems).values({
    taskListId: taskList.id,
    userId,
    title: title.trim(),
    description: description?.trim() || null,
    status: status || 'pending',
    priority: priority || 'medium',
    assigneeId: assigneeId || null,
    dueDate: dueDate ? new Date(dueDate) : null,
    position: nextPosition,
  }).returning();

  // Fetch with relations
  const taskWithRelations = await db.query.taskItems.findFirst({
    where: eq(taskItems.id, newTask.id),
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

  // Broadcast task creation
  if (process.env.INTERNAL_REALTIME_URL) {
    try {
      const requestBody = JSON.stringify({
        pageId,
        event: 'task_created',
        payload: taskWithRelations,
      });

      await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
        method: 'POST',
        headers: createSignedBroadcastHeaders(requestBody),
        body: requestBody,
      });
    } catch (error) {
      loggers.realtime.error('Failed to broadcast task creation:', error as Error);
    }
  }

  return NextResponse.json(taskWithRelations, { status: 201 });
}
