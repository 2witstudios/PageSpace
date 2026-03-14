import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkDriveAccess } from '@pagespace/lib/server';
import { db, workflows, pages, eq, and } from '@pagespace/db';
import { validateCronExpression, validateTimezone, getNextRunDate } from '@/lib/workflows/cron-utils';
import { getActorInfo, logActivity } from '@pagespace/lib/monitoring/activity-logger';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const eventTriggerSchema = z.object({
  operation: z.string().min(1),
  resourceType: z.string().min(1),
});

const updateWorkflowSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  agentPageId: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  contextPageIds: z.array(z.string()).optional(),
  triggerType: z.enum(['cron', 'event']).optional(),
  cronExpression: z.string().min(1).optional().nullable(),
  timezone: z.string().optional(),
  isEnabled: z.boolean().optional(),
  eventTriggers: z.array(eventTriggerSchema).optional().nullable(),
  watchedFolderIds: z.array(z.string()).optional().nullable(),
  eventDebounceSecs: z.number().int().min(5).max(3600).optional().nullable(),
});

async function getWorkflowWithAuth(workflowId: string, userId: string) {
  const [workflow] = await db
    .select()
    .from(workflows)
    .where(eq(workflows.id, workflowId));

  if (!workflow) return { error: NextResponse.json({ error: 'Workflow not found' }, { status: 404 }) };

  const access = await checkDriveAccess(workflow.driveId, userId);
  if (!access.drive) return { error: NextResponse.json({ error: 'Drive not found' }, { status: 404 }) };
  if (!access.isOwner && !access.isAdmin) {
    return { error: NextResponse.json({ error: 'Only drive owners and admins can manage workflows' }, { status: 403 }) };
  }

  return { workflow };
}

// GET /api/workflows/[workflowId]
export async function GET(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const { workflowId } = await context.params;
  const result = await getWorkflowWithAuth(workflowId, auth.userId);
  if ('error' in result) return result.error;

  return NextResponse.json(result.workflow);
}

// PATCH /api/workflows/[workflowId]
export async function PATCH(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  const { workflowId } = await context.params;
  const result = await getWorkflowWithAuth(workflowId, auth.userId);
  if ('error' in result) return result.error;

  const workflow = result.workflow;
  const body = await request.json();
  const parsed = updateWorkflowSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 });
  }

  const data = parsed.data;

  // If changing agent, validate it exists, is AI_CHAT, not trashed, and in same drive
  if (data.agentPageId) {
    const [agent] = await db
      .select()
      .from(pages)
      .where(and(eq(pages.id, data.agentPageId), eq(pages.driveId, workflow.driveId), eq(pages.isTrashed, false)));

    if (!agent || agent.type !== 'AI_CHAT') {
      return NextResponse.json({ error: 'Invalid agent page' }, { status: 400 });
    }
  }

  // Determine effective trigger type
  const triggerType = data.triggerType ?? workflow.triggerType;

  // Validate timezone
  const effectiveTimezone = data.timezone ?? workflow.timezone;
  const tzValidation = validateTimezone(effectiveTimezone);
  if (!tzValidation.valid) {
    return NextResponse.json({ error: tzValidation.error }, { status: 400 });
  }

  // If changing cron expression, validate it
  if (data.cronExpression) {
    const cronValidation = validateCronExpression(data.cronExpression);
    if (!cronValidation.valid) {
      return NextResponse.json({ error: `Invalid cron expression: ${cronValidation.error}` }, { status: 400 });
    }
  }

  // Validate: cron workflows need a cron expression, event workflows need triggers
  if (triggerType === 'cron') {
    // Resolve effective cronExpression: explicit null from payload means "clear it"
    const cronExpr = data.cronExpression !== undefined ? data.cronExpression : workflow.cronExpression;
    if (!cronExpr) {
      return NextResponse.json({ error: 'Cron workflows require a cron expression' }, { status: 400 });
    }
  }
  if (triggerType === 'event') {
    const triggers = data.eventTriggers !== undefined
      ? data.eventTriggers
      : (workflow.eventTriggers as Array<{ operation: string; resourceType: string }> | null);
    if (!triggers || triggers.length === 0) {
      return NextResponse.json({ error: 'Event workflows require at least one event trigger' }, { status: 400 });
    }
  }

  // Compute nextRunAt based on updated fields (only for cron workflows)
  const isEnabled = data.isEnabled ?? workflow.isEnabled;
  let nextRunAt: Date | null = null;
  if (triggerType === 'cron') {
    const cronExpression = data.cronExpression ?? workflow.cronExpression;
    const timezone = data.timezone ?? workflow.timezone;
    nextRunAt = isEnabled && cronExpression ? getNextRunDate(cronExpression, timezone) : null;
  }

  const [updated] = await db
    .update(workflows)
    .set({
      ...data,
      nextRunAt,
      updatedAt: new Date(),
    })
    .where(eq(workflows.id, workflowId))
    .returning();

  // Audit logging (fire-and-forget)
  getActorInfo(auth.userId).then(actorInfo => {
    logActivity({
      userId: auth.userId,
      ...actorInfo,
      operation: 'update',
      resourceType: 'workflow',
      resourceId: workflowId,
      resourceTitle: updated.name,
      driveId: workflow.driveId,
      updatedFields: Object.keys(data).filter(k => (data as Record<string, unknown>)[k] !== undefined),
      metadata: { triggerType: updated.triggerType },
    }).catch(() => {});
  }).catch(() => {});

  return NextResponse.json(updated);
}

// DELETE /api/workflows/[workflowId]
export async function DELETE(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  const { workflowId } = await context.params;
  const result = await getWorkflowWithAuth(workflowId, auth.userId);
  if ('error' in result) return result.error;

  await db.delete(workflows).where(eq(workflows.id, workflowId));

  // Audit logging (fire-and-forget)
  getActorInfo(auth.userId).then(actorInfo => {
    logActivity({
      userId: auth.userId,
      ...actorInfo,
      operation: 'delete',
      resourceType: 'workflow',
      resourceId: workflowId,
      resourceTitle: result.workflow.name,
      driveId: result.workflow.driveId,
    }).catch(() => {});
  }).catch(() => {});

  return NextResponse.json({ success: true });
}
