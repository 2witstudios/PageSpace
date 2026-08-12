import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope, isPrincipalDriveOwnerOrAdmin, type AuthResult } from '@/lib/auth';
import { checkDriveAccess, getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket/socket-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { db } from '@pagespace/db/db'
import { eq, and } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { workflows } from '@pagespace/db/schema/workflows';
import { validateCronExpression, validateTimezone, getNextRunDate } from '@/lib/workflows/cron-utils';
import { resolveTimezone } from '@/lib/ai/core/personalization-utils';
import { workflowStepsSchema, validateStepsForApi } from '@/lib/workflows/steps-api-validation';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };
const MANAGEABLE_TRIGGER_TYPE = 'cron' as const;

const updateWorkflowSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  agentPageId: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  // Replaces the whole chain when provided; steps cannot be nulled back to a
  // legacy workflow (create a new one instead).
  steps: workflowStepsSchema.optional(),
  instructionPageId: z.string().nullable().optional(),
  contextPageIds: z.array(z.string()).optional(),
  cronExpression: z.string().min(1).optional().nullable(),
  timezone: z.string().optional(),
  isEnabled: z.boolean().optional(),
}).strict();

async function getWorkflowWithAuth(workflowId: string, auth: AuthResult) {
  const [workflow] = await db
    .select()
    .from(workflows)
    .where(eq(workflows.id, workflowId));

  // 404 backing workflows (cronExpression IS NULL) the same way we 404
  // unknown rows: they're owned by task_triggers / calendar_triggers and
  // must not be editable from the cron management surface.
  if (!workflow || workflow.triggerType !== MANAGEABLE_TRIGGER_TYPE || !workflow.cronExpression) {
    return { error: NextResponse.json({ error: 'Workflow not found' }, { status: 404 }) };
  }

  const scopeError = checkMCPDriveScope(auth, workflow.driveId);
  if (scopeError) return { error: scopeError };

  if (!(await isPrincipalDriveOwnerOrAdmin(auth, workflow.driveId))) {
    const access = await checkDriveAccess(workflow.driveId, auth.userId);
    if (!access.drive) return { error: NextResponse.json({ error: 'Drive not found' }, { status: 404 }) };
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
  const result = await getWorkflowWithAuth(workflowId, auth);
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
  const result = await getWorkflowWithAuth(workflowId, auth);
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

  // If changing the instruction page, validate it exists, is not trashed, and is in the same drive
  if (data.instructionPageId) {
    const [instructionPage] = await db
      .select()
      .from(pages)
      .where(and(eq(pages.id, data.instructionPageId), eq(pages.driveId, workflow.driveId), eq(pages.isTrashed, false)));

    if (!instructionPage) {
      return NextResponse.json({ error: 'Instruction page not found in this drive' }, { status: 400 });
    }
  }

  // Validate replacement steps: allowlist, $payload path syntax, ref-free
  // schema parse, and drive-scoped AI_CHAT checks for effective agents.
  let stepWarnings: string[] = [];
  if (data.steps) {
    const stepsResult = await validateStepsForApi(data.steps, {
      driveId: workflow.driveId,
      workflowAgentPageId: data.agentPageId ?? workflow.agentPageId,
    });
    if (!stepsResult.ok) {
      return NextResponse.json({ error: stepsResult.error }, { status: 400 });
    }
    stepWarnings = stepsResult.warnings;
  }

  // Validate timezone. Body value wins, else the workflow's own stored zone,
  // else the caller's profile, else UTC — the same chain create resolves, so
  // the rule is one rule (#2404). The stored column is NOT NULL, so the profile
  // tier is a guard that costs no query in the normal case.
  const effectiveTimezone = await resolveTimezone(
    data.timezone?.trim() || workflow.timezone,
    auth.userId,
  );
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
  const nextRunAt = isEnabled ? getNextRunDate(cronExpr, effectiveTimezone) : null;

  const [updated] = await db
    .update(workflows)
    .set({
      ...data,
      // Persist the CANONICAL zone this request validated, not the raw field —
      // `...data` would spread a space-padded or whitespace-only string past the
      // validation above and straight into the column. The cron runner hands
      // that stored value to getNextRunDate on every tick, so an unschedulable
      // string there leaves nextRunAt stale and the workflow re-firing forever.
      // Absent stays undefined, which Drizzle reads as "no change".
      timezone: data.timezone === undefined ? undefined : effectiveTimezone,
      nextRunAt,
      updatedAt: new Date(),
    })
    .where(eq(workflows.id, workflowId))
    .returning();

  auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'workflow', resourceId: workflowId, details: { updatedFields: Object.keys(data) } });

  try {
    const recipientUserIds = await getDriveRecipientUserIds(workflow.driveId);
    await broadcastDriveEvent(createDriveEventPayload(workflow.driveId, 'updated', { resourceType: 'workflow' }), recipientUserIds);
  } catch (broadcastError) {
    loggers.api.error('[WORKFLOWS_PATCH_BROADCAST]', broadcastError as Error);
  }

  return NextResponse.json(
    stepWarnings.length > 0 ? { ...updated, warnings: stepWarnings } : updated
  );
}

// DELETE /api/workflows/[workflowId]
export async function DELETE(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  const { workflowId } = await context.params;
  const result = await getWorkflowWithAuth(workflowId, auth);
  if ('error' in result) return result.error;

  await db.delete(workflows).where(eq(workflows.id, workflowId));

  auditRequest(request, { eventType: 'data.delete', userId: auth.userId, resourceType: 'workflow', resourceId: workflowId });

  try {
    const recipientUserIds = await getDriveRecipientUserIds(result.workflow.driveId);
    await broadcastDriveEvent(createDriveEventPayload(result.workflow.driveId, 'updated', { resourceType: 'workflow' }), recipientUserIds);
  } catch (broadcastError) {
    loggers.api.error('[WORKFLOWS_DELETE_BROADCAST]', broadcastError as Error);
  }

  return NextResponse.json({ success: true });
}
