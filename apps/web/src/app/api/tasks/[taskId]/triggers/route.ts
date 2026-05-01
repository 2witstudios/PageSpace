import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { canUserEditPage } from '@pagespace/lib/permissions/permissions';
import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { taskItems, taskLists } from '@pagespace/db/schema/tasks';
import { workflows } from '@pagespace/db/schema/workflows';
import { createTaskTriggerWorkflow } from '@/lib/workflows/task-trigger-helpers';
import { broadcastTaskEvent } from '@/lib/websocket';
import { loggers } from '@pagespace/lib/logging/logger-config';

const logger = loggers.api.child({ module: 'task-triggers-api' });

const SESSION_READ = { allow: ['session'] as const, requireCSRF: false };
const SESSION_WRITE = { allow: ['session'] as const, requireCSRF: true };

const upsertTriggerSchema = z.object({
  triggerType: z.enum(['due_date', 'completion']),
  agentPageId: z.string().min(1),
  prompt: z.string().max(10000).optional(),
  instructionPageId: z.string().nullable().optional(),
  contextPageIds: z.array(z.string()).max(10).optional(),
}).strict().refine(
  (data) => Boolean(data.prompt?.trim()) || Boolean(data.instructionPageId),
  { message: 'Either prompt or instructionPageId is required' }
);

type ResolvedTaskContext = {
  task: typeof taskItems.$inferSelect;
  taskListPageId: string;
  driveId: string;
  timezone: string;
};

async function resolveTaskContext(taskId: string): Promise<ResolvedTaskContext | null> {
  const task = await db.query.taskItems.findFirst({
    where: eq(taskItems.id, taskId),
  });
  if (!task) return null;

  const taskList = await db.query.taskLists.findFirst({
    where: eq(taskLists.id, task.taskListId),
  });
  if (!taskList?.pageId) return null;

  const page = await db.query.pages.findFirst({
    where: eq(pages.id, taskList.pageId),
    columns: { id: true, driveId: true, isTrashed: true },
  });
  if (!page || page.isTrashed) return null;

  return {
    task,
    taskListPageId: taskList.pageId,
    driveId: page.driveId,
    timezone: 'UTC',
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
  const canEdit = await canUserEditPage(userId, ctx.taskListPageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const rows = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.taskItemId, taskId)));

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

  const canEdit = await canUserEditPage(userId, ctx.taskListPageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (parsed.data.triggerType === 'due_date' && !ctx.task.dueDate) {
    return NextResponse.json(
      { error: 'A due date is required before adding a due-date trigger' },
      { status: 400 }
    );
  }

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
      timezone: ctx.timezone,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save trigger';
    logger.warn('Failed to upsert task trigger', { taskId, error: message });
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const triggerTypeDb = parsed.data.triggerType === 'completion' ? 'task_completion' : 'task_due_date';
  const [saved] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.taskItemId, taskId), eq(workflows.triggerType, triggerTypeDb)));

  auditRequest(request, {
    eventType: 'data.write',
    userId,
    resourceType: 'task_triggers',
    resourceId: taskId,
    details: { triggerType: triggerTypeDb },
  });

  void broadcastTaskEvent({
    type: 'task_updated',
    taskId,
    taskListId: ctx.task.taskListId,
    userId,
    pageId: ctx.taskListPageId,
    data: { id: taskId, triggerType: triggerTypeDb },
  });

  return NextResponse.json({ trigger: saved }, { status: 200 });
}
