import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkDriveAccess } from '@pagespace/lib/server';
import { db, workflows, eq, and, ne } from '@pagespace/db';
import { executeWorkflow } from '@/lib/workflows/workflow-executor';
import { getNextRunDate } from '@/lib/workflows/cron-utils';
import { getActorInfo, logActivity } from '@pagespace/lib/monitoring/activity-logger';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

// POST /api/workflows/[workflowId]/run - Manual trigger
export async function POST(
  request: Request,
  context: { params: Promise<{ workflowId: string }> }
) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;

  const { workflowId } = await context.params;

  const [workflow] = await db
    .select()
    .from(workflows)
    .where(eq(workflows.id, workflowId));

  if (!workflow) {
    return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });
  }

  const access = await checkDriveAccess(workflow.driveId, auth.userId);
  if (!access.drive) {
    return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
  }
  if (!access.isOwner && !access.isAdmin) {
    return NextResponse.json({ error: 'Only drive owners and admins can manage workflows' }, { status: 403 });
  }

  // Atomically claim: only mark as running if not already running
  const [claimed] = await db
    .update(workflows)
    .set({ lastRunStatus: 'running', lastRunAt: new Date() })
    .where(and(eq(workflows.id, workflowId), ne(workflows.lastRunStatus, 'running')))
    .returning({ id: workflows.id });

  if (!claimed) {
    return NextResponse.json({ error: 'Workflow is already running' }, { status: 409 });
  }

  // Execute
  let result;
  try {
    result = await executeWorkflow(workflow);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await db
      .update(workflows)
      .set({ lastRunStatus: 'error', lastRunError: errorMsg })
      .where(eq(workflows.id, workflowId));
    return NextResponse.json({ success: false, error: errorMsg }, { status: 500 });
  }

  // Update status — only compute nextRunAt for cron workflows
  const nextRunAt = (workflow.triggerType === 'cron' && workflow.isEnabled && workflow.cronExpression)
    ? getNextRunDate(workflow.cronExpression, workflow.timezone)
    : null;

  await db
    .update(workflows)
    .set({
      lastRunAt: new Date(),
      lastRunStatus: result.success ? 'success' : 'error',
      lastRunError: result.error || null,
      lastRunDurationMs: result.durationMs,
      nextRunAt,
    })
    .where(eq(workflows.id, workflowId));

  // Audit logging (fire-and-forget)
  getActorInfo(auth.userId).then(actorInfo => {
    logActivity({
      userId: auth.userId,
      ...actorInfo,
      operation: 'update',
      resourceType: 'workflow',
      resourceId: workflowId,
      resourceTitle: workflow.name,
      driveId: workflow.driveId,
      metadata: { action: 'manual_run', success: result.success, durationMs: result.durationMs },
    }).catch(() => {});
  }).catch(() => {});

  return NextResponse.json({
    success: result.success,
    responseText: result.responseText,
    toolCallCount: result.toolCallCount,
    durationMs: result.durationMs,
    error: result.error,
  });
}
