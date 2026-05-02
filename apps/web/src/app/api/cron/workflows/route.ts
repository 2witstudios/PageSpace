import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq, and, lte, sql } from '@pagespace/db/operators'
import { workflows } from '@pagespace/db/schema/workflows';
import { workflowRuns } from '@pagespace/db/schema/workflow-runs';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { executeWorkflow, type WorkflowExecutionInput } from '@/lib/workflows/workflow-executor';
import { getNextRunDate } from '@/lib/workflows/cron-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { audit } from '@pagespace/lib/audit/audit-log';

const STUCK_RUN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CONCURRENT_WORKFLOWS = 5;

export async function POST(req: Request) {
  const authError = validateSignedCronRequest(req);
  if (authError) return authError;

  try {
    const now = new Date();

    // 1. Reset stuck workflow_runs (running > 10 min). Operates on workflow_runs
    //    only — trigger / workflow tables no longer carry per-fire state, so the
    //    sweeper has one place to look across every workflow domain.
    const stuckCutoff = new Date(now.getTime() - STUCK_RUN_TIMEOUT_MS);
    await db
      .update(workflowRuns)
      .set({
        status: 'error',
        endedAt: now,
        error: 'Workflow run timed out (stuck in running state)',
      })
      .where(and(
        eq(workflowRuns.status, 'running'),
        lte(workflowRuns.startedAt, stuckCutoff),
      ));

    // 2. Discover cron workflows that are due AND don't have an in-flight run.
    //    The NOT EXISTS subquery uses the running_claim partial unique index for
    //    a fast lookup — no scan of historical workflow_runs rows.
    const dueWorkflows = await db
      .select()
      .from(workflows)
      .where(and(
        eq(workflows.isEnabled, true),
        eq(workflows.triggerType, 'cron'),
        lte(workflows.nextRunAt, now),
        sql`NOT EXISTS (
          SELECT 1 FROM ${workflowRuns}
          WHERE ${workflowRuns.workflowId} = ${workflows.id}
            AND ${workflowRuns.status} = 'running'
        )`,
      ));

    if (dueWorkflows.length === 0) {
      audit({ eventType: 'data.write', resourceType: 'cron_job', resourceId: 'workflows', details: { executed: 0, failed: 0 } });
      return NextResponse.json({ message: 'No workflows due', executed: 0 });
    }

    loggers.api.info(`Workflow cron: Found ${dueWorkflows.length} due workflows`);

    type WorkflowRow = typeof dueWorkflows[number];

    const toExecutionInput = (workflow: WorkflowRow): WorkflowExecutionInput => ({
      workflowId: workflow.id,
      workflowName: workflow.name,
      driveId: workflow.driveId,
      createdBy: workflow.createdBy,
      agentPageId: workflow.agentPageId,
      prompt: workflow.prompt,
      contextPageIds: (workflow.contextPageIds as string[] | null) ?? [],
      instructionPageId: workflow.instructionPageId,
      timezone: workflow.timezone,
      source: { table: 'cron', id: null, triggerAt: workflow.nextRunAt },
    });

    // advanceNextRunAt throws on failure so the surrounding Promise.allSettled
    // turns the failure into a recorded error in the response, instead of
    // leaving a stale nextRunAt in the past — which would make the next
    // cron tick re-fire the same workflow.
    const advanceNextRunAt = async (workflow: WorkflowRow) => {
      if (!workflow.cronExpression) return;
      const nextRunAt = getNextRunDate(workflow.cronExpression, workflow.timezone);
      await db.update(workflows).set({ nextRunAt }).where(eq(workflows.id, workflow.id));
    };

    let executed = 0;
    let totalAttempted = 0;
    const errors: string[] = [];

    for (let i = 0; i < dueWorkflows.length; i += MAX_CONCURRENT_WORKFLOWS) {
      const batch = dueWorkflows.slice(i, i + MAX_CONCURRENT_WORKFLOWS);

      const batchResults = await Promise.allSettled(
        batch.map(async (workflow) => {
          // The atomic claim is the workflow_runs partial unique index inside
          // the executor. If a peer cron invocation already claimed this
          // workflow, claimConflict comes back true — we leave nextRunAt
          // alone so the running fire's natural completion governs the
          // next schedule advance.
          const result = await executeWorkflow(toExecutionInput(workflow));
          if (!result.claimConflict) {
            await advanceNextRunAt(workflow);
          }
          return { workflow, result };
        }),
      );

      for (let j = 0; j < batchResults.length; j++) {
        const settled = batchResults[j];
        if (settled.status === 'fulfilled') {
          if (settled.value.result.claimConflict) continue;
          totalAttempted++;
          if (settled.value.result.success) {
            executed++;
          } else {
            errors.push(`${settled.value.workflow.name}: ${settled.value.result.error}`);
          }
          if (settled.value.result.finalizeError) {
            errors.push(`${settled.value.workflow.name}: finalize failed: ${settled.value.result.finalizeError}`);
          }
        } else {
          totalAttempted++;
          const workflow = batch[j];
          const errorMsg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
          loggers.api.error(`Workflow cron: Failed for workflow ${workflow.id}`, { error: errorMsg });
          errors.push(`${workflow.name}: ${errorMsg}`);
          // Best-effort schedule advance after a fire-or-advance crash —
          // if this also fails we just log; the next sweep will catch any
          // workflow that ends up stuck.
          try {
            await advanceNextRunAt(workflow);
          } catch (advanceErr) {
            const advanceErrorMsg = advanceErr instanceof Error ? advanceErr.message : String(advanceErr);
            loggers.api.error(`Workflow cron: Failed to advance nextRunAt for ${workflow.id}`, { error: advanceErrorMsg });
          }
        }
      }
    }

    loggers.api.info(`Workflow cron: Complete. Executed ${executed}/${totalAttempted}`);

    audit({ eventType: 'data.write', resourceType: 'cron_job', resourceId: 'workflows', details: { executed, failed: errors.length } });

    return NextResponse.json({
      message: 'Workflow cron complete',
      executed,
      total: totalAttempted,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    loggers.api.error('Workflow cron error:', error as Error);
    return NextResponse.json({ error: 'Workflow cron job failed' }, { status: 500 });
  }
}
