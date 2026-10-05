import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkDriveAccess } from '@pagespace/lib/services/drive-member-service';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { workflows } from '@pagespace/db/schema/workflows';
import { executeWorkflow, type WorkflowExecutionInput } from '@/lib/workflows/workflow-executor';
import { getNextRunDate } from '@/lib/workflows/cron-utils';
import { creditAdmission } from '@/lib/workflows/workflow-credit-gate';
import type { GateReason } from '@pagespace/lib/billing/credit-core';
import { creditGatePayload } from '@/lib/subscription/credit-gate-response';
import { automationRunOwner } from '@pagespace/lib/permissions/automation-ownership';

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

  // [D-OW-36] A workflow whose creator left runs as nobody, a Run included: an Owner or Admin reassigns or deletes it first.
  const owner = automationRunOwner(workflow);
  if (!owner.runs) {
    return NextResponse.json({ error: owner.error, code: owner.reason }, { status: 409 });
  }

  const executionInput: WorkflowExecutionInput = {
    workflowId: workflow.id,
    workflowName: workflow.name,
    driveId: workflow.driveId,
    createdBy: owner.ownerId,
    agentPageId: workflow.agentPageId,
    prompt: workflow.prompt,
    steps: workflow.steps,
    contextPageIds: (workflow.contextPageIds as string[] | null) ?? [],
    instructionPageId: workflow.instructionPageId,
    timezone: workflow.timezone,
    source: { table: 'manual', id: null, triggerAt: null },
  };

  // Atomic claim is enforced by the workflow_runs partial unique index inside
  // the executor — any concurrent fire (cron / manual) for the same workflow
  // returns claimConflict and we surface a 409. The credit gate runs inside
  // that claim, before any model is built. Pressing Run is the CALLER's spend (the actor
  // pays, as for a channel @mention): the gate admits it as them, so their per-consumer caps
  // on the drive wallet bind (WAL-7). It still spends only the drive wallet. Usage is recorded
  // under the workflow's creator, as for every run.
  let deniedReason: GateReason | undefined;
  const result = await executeWorkflow(executionInput, {
    admit: creditAdmission(executionInput, 'interactive', (reason) => { deniedReason = reason; }, auth.userId),
  });

  if (result.claimConflict) {
    return NextResponse.json({ error: 'Workflow is already running' }, { status: 409 });
  }

  // Refused by the gate: out_of_credits -> 402, a cap -> 429. The Run button
  // toasts `error`, so it carries the readable message; `code` the reason. The
  // schedule is not advanced — nothing ran.
  if (result.skipped && deniedReason) {
    const denied = creditGatePayload(deniedReason);
    return NextResponse.json({ error: denied.message, code: denied.error }, { status: denied.status });
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
    finalizeError: result.finalizeError,
  });
}
