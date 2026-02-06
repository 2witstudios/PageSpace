import { NextResponse } from 'next/server';
import { db, taskLists, taskStatusConfigs, taskItems, eq, and, asc, desc, inArray } from '@pagespace/db';
import { DEFAULT_TASK_STATUSES } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserEditPage, canUserViewPage } from '@pagespace/lib/server';
import { broadcastTaskEvent } from '@/lib/websocket';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * GET /api/pages/[pageId]/tasks/statuses
 * Get all status configs for a task list
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ pageId: string }> }
) {
  const { pageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const canView = await canUserViewPage(userId, pageId);
  if (!canView) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const taskList = await db.query.taskLists.findFirst({
    where: eq(taskLists.pageId, pageId),
  });

  if (!taskList) {
    // Return default statuses if no task list exists yet
    return NextResponse.json({
      statusConfigs: DEFAULT_TASK_STATUSES.map((s, i) => ({
        id: `default-${s.slug}`,
        taskListId: '',
        ...s,
        position: i,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
    });
  }

  const statusConfigs = await db.query.taskStatusConfigs.findMany({
    where: eq(taskStatusConfigs.taskListId, taskList.id),
    orderBy: [asc(taskStatusConfigs.position)],
  });

  return NextResponse.json({ statusConfigs });
}

/**
 * POST /api/pages/[pageId]/tasks/statuses
 * Add a new custom status to a task list
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ pageId: string }> }
) {
  const { pageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const canEdit = await canUserEditPage(userId, pageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'You need edit permission to manage statuses' }, { status: 403 });
  }

  const body = await req.json();
  const { name, color, group, position } = body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 });
  }

  if (!group || !['todo', 'in_progress', 'done'].includes(group)) {
    return NextResponse.json({ error: 'Group must be one of: todo, in_progress, done' }, { status: 400 });
  }

  if (!color || typeof color !== 'string') {
    return NextResponse.json({ error: 'Color is required' }, { status: 400 });
  }

  // Get or create task list
  let taskList = await db.query.taskLists.findFirst({
    where: eq(taskLists.pageId, pageId),
  });

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
  }

  // Generate slug
  const slug = slugify(name);
  if (!slug) {
    return NextResponse.json({ error: 'Name must contain alphanumeric characters' }, { status: 400 });
  }

  // Check for slug collision
  const existingSlug = await db.query.taskStatusConfigs.findFirst({
    where: and(
      eq(taskStatusConfigs.taskListId, taskList.id),
      eq(taskStatusConfigs.slug, slug),
    ),
  });

  if (existingSlug) {
    return NextResponse.json({ error: `A status with slug "${slug}" already exists` }, { status: 409 });
  }

  // Determine position
  let newPosition = position;
  if (newPosition === undefined) {
    const lastConfig = await db.query.taskStatusConfigs.findFirst({
      where: eq(taskStatusConfigs.taskListId, taskList.id),
      orderBy: [desc(taskStatusConfigs.position)],
    });
    newPosition = (lastConfig?.position ?? -1) + 1;
  }

  const [newConfig] = await db.insert(taskStatusConfigs).values({
    taskListId: taskList.id,
    name: name.trim(),
    slug,
    color,
    group,
    position: newPosition,
  }).returning();

  // Broadcast update
  await broadcastTaskEvent({
    type: 'task_updated',
    taskListId: taskList.id,
    userId,
    pageId,
    data: { statusConfigAdded: newConfig },
  });

  return NextResponse.json(newConfig, { status: 201 });
}

/**
 * PUT /api/pages/[pageId]/tasks/statuses
 * Bulk update status configs (for reordering, renaming, etc.)
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ pageId: string }> }
) {
  const { pageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const canEdit = await canUserEditPage(userId, pageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'You need edit permission to manage statuses' }, { status: 403 });
  }

  const body = await req.json();
  const { statuses } = body;

  if (!Array.isArray(statuses)) {
    return NextResponse.json({ error: 'statuses array is required' }, { status: 400 });
  }

  const taskList = await db.query.taskLists.findFirst({
    where: eq(taskLists.pageId, pageId),
  });

  if (!taskList) {
    return NextResponse.json({ error: 'Task list not found' }, { status: 404 });
  }

  // Validate each status
  for (const s of statuses) {
    if (!s.id) {
      return NextResponse.json({ error: 'Each status must have an id' }, { status: 400 });
    }
    if (!s.name || typeof s.name !== 'string') {
      return NextResponse.json({ error: 'Each status must have a name' }, { status: 400 });
    }
    if (!['todo', 'in_progress', 'done'].includes(s.group)) {
      return NextResponse.json({ error: 'Each status group must be: todo, in_progress, or done' }, { status: 400 });
    }
  }

  // Update each status config
  await db.transaction(async (tx) => {
    for (let i = 0; i < statuses.length; i++) {
      const s = statuses[i];
      await tx.update(taskStatusConfigs)
        .set({
          name: s.name.trim(),
          color: s.color,
          group: s.group,
          position: s.position ?? i,
        })
        .where(and(
          eq(taskStatusConfigs.id, s.id),
          eq(taskStatusConfigs.taskListId, taskList.id),
        ));
    }
  });

  // Fetch updated configs
  const updatedConfigs = await db.query.taskStatusConfigs.findMany({
    where: eq(taskStatusConfigs.taskListId, taskList.id),
    orderBy: [asc(taskStatusConfigs.position)],
  });

  // Broadcast update
  await broadcastTaskEvent({
    type: 'task_updated',
    taskListId: taskList.id,
    userId,
    pageId,
    data: { statusConfigsUpdated: updatedConfigs },
  });

  return NextResponse.json({ statusConfigs: updatedConfigs });
}

/**
 * DELETE /api/pages/[pageId]/tasks/statuses
 * Delete a status config and migrate tasks to a replacement status
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ pageId: string }> }
) {
  const { pageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const canEdit = await canUserEditPage(userId, pageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'You need edit permission to manage statuses' }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const statusId = searchParams.get('statusId');
  const migrateToSlug = searchParams.get('migrateToSlug');

  if (!statusId) {
    return NextResponse.json({ error: 'statusId is required' }, { status: 400 });
  }

  const taskList = await db.query.taskLists.findFirst({
    where: eq(taskLists.pageId, pageId),
  });

  if (!taskList) {
    return NextResponse.json({ error: 'Task list not found' }, { status: 404 });
  }

  // Find the status to delete
  const statusToDelete = await db.query.taskStatusConfigs.findFirst({
    where: and(
      eq(taskStatusConfigs.id, statusId),
      eq(taskStatusConfigs.taskListId, taskList.id),
    ),
  });

  if (!statusToDelete) {
    return NextResponse.json({ error: 'Status config not found' }, { status: 404 });
  }

  // Check if any tasks use this status
  const tasksWithStatus = await db.query.taskItems.findMany({
    where: and(
      eq(taskItems.taskListId, taskList.id),
      eq(taskItems.status, statusToDelete.slug),
    ),
    columns: { id: true },
  });

  if (tasksWithStatus.length > 0 && !migrateToSlug) {
    return NextResponse.json({
      error: 'Cannot delete a status that has tasks. Provide migrateToSlug to move tasks to another status.',
      taskCount: tasksWithStatus.length,
    }, { status: 400 });
  }

  // Verify migration target exists
  if (migrateToSlug) {
    const targetConfig = await db.query.taskStatusConfigs.findFirst({
      where: and(
        eq(taskStatusConfigs.taskListId, taskList.id),
        eq(taskStatusConfigs.slug, migrateToSlug),
      ),
    });

    if (!targetConfig) {
      return NextResponse.json({ error: `Migration target status "${migrateToSlug}" not found` }, { status: 400 });
    }
  }

  // Ensure at least one status remains in each group
  const allConfigs = await db.query.taskStatusConfigs.findMany({
    where: eq(taskStatusConfigs.taskListId, taskList.id),
  });

  const remainingInGroup = allConfigs.filter(
    c => c.group === statusToDelete.group && c.id !== statusId
  );

  if (remainingInGroup.length === 0) {
    return NextResponse.json({
      error: `Cannot delete the last status in the "${statusToDelete.group}" group`,
    }, { status: 400 });
  }

  // Delete status and migrate tasks in a transaction
  await db.transaction(async (tx) => {
    // Migrate tasks to new status
    if (tasksWithStatus.length > 0 && migrateToSlug) {
      const taskIds = tasksWithStatus.map(t => t.id);
      await tx.update(taskItems)
        .set({ status: migrateToSlug })
        .where(inArray(taskItems.id, taskIds));
    }

    // Delete the status config
    await tx.delete(taskStatusConfigs).where(eq(taskStatusConfigs.id, statusId));
  });

  // Broadcast update
  await broadcastTaskEvent({
    type: 'task_updated',
    taskListId: taskList.id,
    userId,
    pageId,
    data: {
      statusConfigDeleted: statusToDelete.slug,
      migratedTo: migrateToSlug,
      migratedCount: tasksWithStatus.length,
    },
  });

  return NextResponse.json({ success: true });
}
