import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkDriveAccess } from '@pagespace/lib/services/drive-member-service';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { db } from '@pagespace/db/db'
import { eq, and, ne } from '@pagespace/db/operators'
import { workflows } from '@pagespace/db/schema/workflows';
import { executeWorkflow, type WorkflowExecutionInput } from '@/lib/workflows/workflow-executor';
import { getNextRunDate } from '@/lib/workflows/cron-utils';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };
const MANAGEABLE_TRIGGER_TYPE = 'cron' as const;

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

  if (!workflow || workflow.triggerType !== MANAGEABLE_TRIGGER_TYPE) {
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

  const executionInput: WorkflowExecutionInput = {
    workflowId: workflow.id,
    workflowName: workflow.name,
    driveId: workflow.driveId,
    createdBy: workflow.createdBy,
    agentPageId: workflow.agentPageId,
    prompt: workflow.prompt,
    contextPageIds: (workflow.contextPageIds as string[] | null) ?? [],
    instructionPageId: workflow.instructionPageId,
    timezone: workflow.timezone,
  };

  // Execute
  let result;
  try {
    result = await executeWorkflow(executionInput);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await db
      .update(workflows)
      .set({ lastRunStatus: 'error', lastRunError: errorMsg })
      .where(eq(workflows.id, workflowId));
    return NextResponse.json({ success: false, error: errorMsg }, { status: 500 });
  }

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

  auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'workflow', resourceId: workflowId, details: { action: 'run', trigger: 'manual' } });

  return NextResponse.json({
    success: result.success,
    responseText: result.responseText,
    toolCallCount: result.toolCallCount,
    durationMs: result.durationMs,
    error: result.error,
  });
}
