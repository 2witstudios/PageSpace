import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkDriveAccess } from '@pagespace/lib/services/drive-member-service';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
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

  // Backing workflows (those owned by task_triggers / calendar_triggers)
  // share triggerType='cron' but have cronExpression=null. They are not
  // user-runnable through this surface — fire them via their own trigger.
  if (!workflow || workflow.triggerType !== MANAGEABLE_TRIGGER_TYPE || !workflow.cronExpression) {
    return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });
  }

  const access = await checkDriveAccess(workflow.driveId, auth.userId);
  if (!access.drive) {
    return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
  }
  if (!access.isOwner && !access.isAdmin) {
    return NextResponse.json({ error: 'Only drive owners and admins can manage workflows' }, { status: 403 });
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
    source: { table: 'manual', id: null, triggerAt: null },
  };

  // Atomic claim is enforced by the workflow_runs partial unique index inside
  // the executor — any concurrent fire (cron / manual) for the same workflow
  // returns claimConflict and we surface a 409.
  const result = await executeWorkflow(executionInput);

  if (result.claimConflict) {
    return NextResponse.json({ error: 'Workflow is already running' }, { status: 409 });
  }

  // Advance the schedule so the next cron tick doesn't re-fire immediately.
  if (workflow.isEnabled && workflow.cronExpression) {
    try {
      const nextRunAt = getNextRunDate(workflow.cronExpression, workflow.timezone);
      await db.update(workflows).set({ nextRunAt }).where(eq(workflows.id, workflowId));
    } catch { /* invalid cron — leave nextRunAt as-is */ }
  }

  auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'workflow', resourceId: workflowId, details: { action: 'run', trigger: 'manual' } });

  return NextResponse.json({
    success: result.success,
    responseText: result.responseText,
    toolCallCount: result.toolCallCount,
    durationMs: result.durationMs,
    error: result.error,
  });
}
