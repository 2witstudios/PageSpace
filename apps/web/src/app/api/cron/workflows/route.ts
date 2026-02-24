import { NextResponse } from 'next/server';
import { db, workflows, eq, and, lte, ne, inArray } from '@pagespace/db';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { executeWorkflow } from '@/lib/workflows/workflow-executor';
import { getNextRunDate } from '@/lib/workflows/cron-utils';
import { loggers } from '@pagespace/lib/server';

const STUCK_WORKFLOW_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CONCURRENT_WORKFLOWS = 5;

export async function POST(req: Request) {
  const authError = validateSignedCronRequest(req);
  if (authError) return authError;

  try {
    const now = new Date();

    // Reset stuck cron workflows (running for >10 min) and advance their nextRunAt
    // so they aren't immediately re-claimed in the same cron invocation.
    // Scoped to triggerType='cron' to avoid incorrectly resetting long-running event workflows.
    const stuckCutoff = new Date(now.getTime() - STUCK_WORKFLOW_TIMEOUT_MS);
    const stuckWorkflows = await db
      .update(workflows)
      .set({ lastRunStatus: 'error', lastRunError: 'Workflow timed out (stuck in running state)' })
      .where(
        and(
          eq(workflows.triggerType, 'cron'),
          eq(workflows.lastRunStatus, 'running'),
          lte(workflows.lastRunAt, stuckCutoff)
        )
      )
      .returning();

    // Advance nextRunAt for stuck workflows so they schedule their next proper run
    for (const wf of stuckWorkflows) {
      if (wf.cronExpression) {
        try {
          const nextRunAt = getNextRunDate(wf.cronExpression, wf.timezone);
          await db.update(workflows).set({ nextRunAt }).where(eq(workflows.id, wf.id));
        } catch { /* invalid cron — leave nextRunAt as-is */ }
      }
    }

    // Discover which cron workflows are due (read-only query)
    const dueWorkflows = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.isEnabled, true),
          eq(workflows.triggerType, 'cron'),
          lte(workflows.nextRunAt, now),
          ne(workflows.lastRunStatus, 'running')
        )
      );

    if (dueWorkflows.length === 0) {
      return NextResponse.json({ message: 'No workflows due', executed: 0 });
    }

    loggers.api.info(`Workflow cron: Found ${dueWorkflows.length} due workflows`);

    type WorkflowRow = typeof dueWorkflows[number];

    const executeOne = async (workflow: WorkflowRow) => {
      const result = await executeWorkflow(workflow);

      let nextRunAt: Date | undefined;
      try {
        nextRunAt = getNextRunDate(workflow.cronExpression!, workflow.timezone);
      } catch {
        loggers.api.error(`Workflow cron: Failed to compute nextRunAt for ${workflow.id}`);
      }

      await db
        .update(workflows)
        .set({
          lastRunAt: new Date(),
          lastRunStatus: result.success ? 'success' : 'error',
          lastRunError: result.error || null,
          lastRunDurationMs: result.durationMs,
          ...(nextRunAt ? { nextRunAt } : {}),
        })
        .where(eq(workflows.id, workflow.id));

      return { workflow, result };
    };

    // Claim and execute in batches to avoid the stuck-workflow timeout racing
    // against not-yet-started items from a single large claim.
    let executed = 0;
    let totalClaimed = 0;
    const errors: string[] = [];

    for (let i = 0; i < dueWorkflows.length; i += MAX_CONCURRENT_WORKFLOWS) {
      const batch = dueWorkflows.slice(i, i + MAX_CONCURRENT_WORKFLOWS);
      const batchIds = batch.map(w => w.id);

      // Atomically claim this batch (UPDATE...RETURNING prevents double-execution)
      const claimed = await db
        .update(workflows)
        .set({ lastRunStatus: 'running', lastRunAt: new Date() })
        .where(
          and(
            inArray(workflows.id, batchIds),
            ne(workflows.lastRunStatus, 'running')
          )
        )
        .returning();

      if (claimed.length === 0) continue;
      totalClaimed += claimed.length;

      const batchResults = await Promise.allSettled(claimed.map(executeOne));

      for (let j = 0; j < batchResults.length; j++) {
        const settled = batchResults[j];
        if (settled.status === 'fulfilled') {
          if (settled.value.result.success) {
            executed++;
          } else {
            errors.push(`${settled.value.workflow.name}: ${settled.value.result.error}`);
          }
        } else {
          const workflow = claimed[j];
          const errorMsg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
          loggers.api.error(`Workflow cron: Failed for workflow ${workflow.id}`, { error: errorMsg });
          errors.push(`${workflow.name}: ${errorMsg}`);

          let nextRunAt: Date | undefined;
          try {
            nextRunAt = getNextRunDate(workflow.cronExpression!, workflow.timezone);
          } catch { /* invalid cron — leave nextRunAt as-is */ }

          await db
            .update(workflows)
            .set({
              lastRunStatus: 'error',
              lastRunError: errorMsg,
              ...(nextRunAt ? { nextRunAt } : {}),
            })
            .where(eq(workflows.id, workflow.id));
        }
      }
    }

    loggers.api.info(`Workflow cron: Complete. Executed ${executed}/${totalClaimed}`);

    return NextResponse.json({
      message: 'Workflow cron complete',
      executed,
      total: totalClaimed,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    loggers.api.error('Workflow cron error:', error as Error);
    return NextResponse.json({ error: 'Workflow cron job failed' }, { status: 500 });
  }
}
