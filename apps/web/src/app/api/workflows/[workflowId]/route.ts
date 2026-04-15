import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkDriveAccess, auditRequest } from '@pagespace/lib/server';
import { db, workflows, pages, eq, and } from '@pagespace/db';
import { validateCronExpression, validateTimezone, getNextRunDate } from '@/lib/workflows/cron-utils';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };
const MANAGEABLE_TRIGGER_TYPE = 'cron' as const;

const updateWorkflowSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  agentPageId: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  contextPageIds: z.array(z.string()).optional(),
  cronExpression: z.string().min(1).optional().nullable(),
  timezone: z.string().optional(),
  isEnabled: z.boolean().optional(),
}).strict();

async function getWorkflowWithAuth(workflowId: string, userId: string) {
  const [workflow] = await db
    .select()
    .from(workflows)
    .where(eq(workflows.id, workflowId));

  if (!workflow || workflow.triggerType !== MANAGEABLE_TRIGGER_TYPE) {
    return { error: NextResponse.json({ error: 'Workflow not found' }, { status: 404 }) };
  }

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

  auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'workflow', resourceId: workflowId });

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

  // Resolve effective cronExpression: explicit null from payload means "clear it"
  const cronExpr = data.cronExpression !== undefined ? data.cronExpression : workflow.cronExpression;
  if (!cronExpr) {
    return NextResponse.json({ error: 'Cron workflows require a cron expression' }, { status: 400 });
  }

  // Compute nextRunAt based on updated fields (only for cron workflows)
  const isEnabled = data.isEnabled ?? workflow.isEnabled;
  const timezone = data.timezone ?? workflow.timezone;
  const nextRunAt = isEnabled ? getNextRunDate(cronExpr, timezone) : null;

  const [updated] = await db
    .update(workflows)
    .set({
      ...data,
      nextRunAt,
      updatedAt: new Date(),
    })
    .where(eq(workflows.id, workflowId))
    .returning();

  auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'workflow', resourceId: workflowId, details: { updatedFields: Object.keys(data) } });

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

  auditRequest(request, { eventType: 'data.delete', userId: auth.userId, resourceType: 'workflow', resourceId: workflowId });

  return NextResponse.json({ success: true });
}
