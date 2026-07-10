import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { taskItems, taskLists } from '@pagespace/db/schema/tasks';
import { workflows } from '@pagespace/db/schema/workflows';
import { taskTriggers } from '@pagespace/db/schema/task-triggers';
import { createTaskTriggerWorkflow } from '@/lib/workflows/task-trigger-helpers';
import { broadcastTaskEvent } from '@/lib/websocket';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getUserTimezone } from '@/lib/ai/core/personalization-utils';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';
import { canPrincipalEditPage } from '@/lib/auth/principal-permissions';

const logger = loggers.api.child({ module: 'task-triggers-api' });

const SESSION_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const SESSION_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const upsertTriggerSchema = z.object({
  triggerType: z.enum(['due_date', 'completion']),
  agentPageId: z.string().min(1),
  prompt: z.string().max(10000).optional(),
  instructionPageId: z.string().nullable().optional(),
  contextPageIds: z.array(z.string()).max(10).optional(),
  timezone: z.string().optional(),
}).strict().refine(
  (data) => Boolean(data.prompt?.trim()) || Boolean(data.instructionPageId),
  { message: 'Either prompt or instructionPageId is required' }
);

type ResolvedTaskContext = {
  task: typeof taskItems.$inferSelect;
  taskListPageId: string;
  taskListId: string | undefined;
  driveId: string;
};

async function resolveTaskContext(taskId: string): Promise<ResolvedTaskContext | null> {
  const task = await db.query.taskItems.findFirst({
    where: eq(taskItems.id, taskId),
    with: { page: { columns: { parentId: true } } },
  });
  if (!task?.page?.parentId) return null;

  const taskListPageId = task.page.parentId;
  const [page, taskList] = await Promise.all([
    db.query.pages.findFirst({
      where: eq(pages.id, taskListPageId),
      columns: { id: true, driveId: true, isTrashed: true },
    }),
    db.query.taskLists.findFirst({
      where: eq(taskLists.pageId, taskListPageId),
      columns: { id: true },
    }),
  ]);
  if (!page || page.isTrashed) return null;

  return {
    task,
    taskListPageId,
    taskListId: taskList?.id,
    driveId: page.driveId,
  };
}

// GET /api/tasks/[taskId]/triggers — list both task triggers (due_date + completion) for this task
export async function GET(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const auth = await authenticateRequestWithOptions(request, SESSION_READ);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const { taskId } = await context.params;

  const ctx = await resolveTaskContext(taskId);
  if (!ctx) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  // Trigger configs include agent IDs and prompt text, so restrict reads to editors
  // — same gate as PUT/DELETE. View-only users cannot inspect trigger configuration.
  const canEdit = await canPrincipalEditPage(auth, ctx.taskListPageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const rows = await db
    .select({
      id: taskTriggers.id,
      taskItemId: taskTriggers.taskItemId,
      triggerType: taskTriggers.triggerType,
      nextRunAt: taskTriggers.nextRunAt,
      lastFiredAt: taskTriggers.lastFiredAt,
      lastFireError: taskTriggers.lastFireError,
      isEnabled: taskTriggers.isEnabled,
      createdAt: taskTriggers.createdAt,
      updatedAt: taskTriggers.updatedAt,
      workflowId: workflows.id,
      agentPageId: workflows.agentPageId,
      prompt: workflows.prompt,
      instructionPageId: workflows.instructionPageId,
      contextPageIds: workflows.contextPageIds,
    })
    .from(taskTriggers)
    .innerJoin(workflows, eq(taskTriggers.workflowId, workflows.id))
    .where(eq(taskTriggers.taskItemId, taskId));

  auditRequest(request, {
    eventType: 'data.read',
    userId,
    resourceType: 'task_triggers',
    resourceId: taskId,
    details: { count: rows.length },
  });

  return NextResponse.json({ triggers: rows });
}

// PUT /api/tasks/[taskId]/triggers — upsert a single trigger for this task
export async function PUT(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const auth = await authenticateRequestWithOptions(request, SESSION_WRITE);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const { taskId } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = upsertTriggerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const ctx = await resolveTaskContext(taskId);
  if (!ctx) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  const canEdit = await canPrincipalEditPage(auth, ctx.taskListPageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (parsed.data.triggerType === 'due_date' && !ctx.task.dueDate) {
    return NextResponse.json(
      { error: 'A due date is required before adding a due-date trigger' },
      { status: 400 }
    );
  }

  // Explicit body value wins, else the caller's profile timezone, else UTC —
  // matching the internal update_task/create_task tools.
  const timezone = parsed.data.timezone?.trim() || (await getUserTimezone(userId)) || 'UTC';

  try {
    await createTaskTriggerWorkflow({
      database: db,
      driveId: ctx.driveId,
      userId,
      taskId,
      taskMetadata: ctx.task.metadata as Record<string, unknown> | null,
      agentTrigger: {
        agentPageId: parsed.data.agentPageId,
        prompt: parsed.data.prompt,
        instructionPageId: parsed.data.instructionPageId ?? undefined,
        contextPageIds: parsed.data.contextPageIds ?? [],
        triggerType: parsed.data.triggerType,
      },
      dueDate: ctx.task.dueDate,
      timezone,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save trigger';
    logger.warn('Failed to upsert task trigger', { taskId, error: message });
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const triggerType = parsed.data.triggerType;
  const [saved] = await db
    .select({
      id: taskTriggers.id,
      taskItemId: taskTriggers.taskItemId,
      triggerType: taskTriggers.triggerType,
      nextRunAt: taskTriggers.nextRunAt,
      lastFiredAt: taskTriggers.lastFiredAt,
      lastFireError: taskTriggers.lastFireError,
      isEnabled: taskTriggers.isEnabled,
      createdAt: taskTriggers.createdAt,
      updatedAt: taskTriggers.updatedAt,
      workflowId: workflows.id,
      agentPageId: workflows.agentPageId,
      prompt: workflows.prompt,
      instructionPageId: workflows.instructionPageId,
      contextPageIds: workflows.contextPageIds,
    })
    .from(taskTriggers)
    .innerJoin(workflows, eq(taskTriggers.workflowId, workflows.id))
    .where(and(eq(taskTriggers.taskItemId, taskId), eq(taskTriggers.triggerType, triggerType)));

  if (!saved) {
    logger.error('Trigger row missing after upsert', { taskId, triggerType });
    return NextResponse.json({ error: 'Failed to retrieve saved trigger' }, { status: 500 });
  }

  auditRequest(request, {
    eventType: 'data.write',
    userId,
    resourceType: 'task_triggers',
    resourceId: taskId,
    details: { triggerType },
  });

  void broadcastTaskEvent({
    type: 'task_updated',
    taskId,
    taskListId: ctx.taskListId,
    userId,
    pageId: ctx.taskListPageId,
    data: { id: taskId, triggerType },
  });

  return NextResponse.json({ trigger: saved }, { status: 200 });
}
