import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkDriveAccess } from '@pagespace/lib/server';
import { db, workflows, eq } from '@pagespace/db';
import { executeWorkflow } from '@/lib/workflows/workflow-executor';
import { getNextRunDate } from '@/lib/workflows/cron-utils';

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

  // Mark as running
  await db
    .update(workflows)
    .set({ lastRunStatus: 'running', lastRunAt: new Date() })
    .where(eq(workflows.id, workflowId));

  // Execute
  const result = await executeWorkflow(workflow);

  // Update status — only compute nextRunAt for cron workflows
  const nextRunAt = (workflow.isEnabled && workflow.cronExpression)
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

  return NextResponse.json({
    success: result.success,
    responseText: result.responseText,
    toolCallCount: result.toolCallCount,
    durationMs: result.durationMs,
    error: result.error,
  });
}
