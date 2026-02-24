import { NextResponse } from 'next/server';
import { db, workflows, eq, and, lte, ne } from '@pagespace/db';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { executeWorkflow } from '@/lib/workflows/workflow-executor';
import { getNextRunDate } from '@/lib/workflows/cron-utils';
import { loggers } from '@pagespace/lib/server';

const STUCK_WORKFLOW_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const maxConcurrentWorkflows = 5;

export async function POST(req: Request) {
  const authError = validateSignedCronRequest(req);
  if (authError) return authError;

  try {
    const now = new Date();

    // Reset stuck workflows (running for >10 min)
    const stuckCutoff = new Date(now.getTime() - STUCK_WORKFLOW_TIMEOUT_MS);
    await db
      .update(workflows)
      .set({ lastRunStatus: 'error', lastRunError: 'Workflow timed out (stuck in running state)' })
      .where(
        and(
          eq(workflows.lastRunStatus, 'running'),
          lte(workflows.lastRunAt, stuckCutoff)
        )
      );

    // Atomically claim due cron workflows (UPDATE...RETURNING prevents double-execution)
    const dueWorkflows = await db
      .update(workflows)
      .set({ lastRunStatus: 'running', lastRunAt: now })
      .where(
        and(
          eq(workflows.isEnabled, true),
          eq(workflows.triggerType, 'cron'),
          lte(workflows.nextRunAt, now),
          ne(workflows.lastRunStatus, 'running')
        )
      )
      .returning();

    if (dueWorkflows.length === 0) {
      return NextResponse.json({ message: 'No workflows due', executed: 0 });
    }

    loggers.api.info(`Workflow cron: Found ${dueWorkflows.length} due workflows`);

    // Execute due workflows with concurrency limit
    const executeOne = async (workflow: typeof dueWorkflows[number]) => {
      const result = await executeWorkflow(workflow);
      const nextRunAt = getNextRunDate(workflow.cronExpression!, workflow.timezone);

      await db
        .update(workflows)
        .set({
          lastRunAt: new Date(),
          lastRunStatus: result.success ? 'success' : 'error',
          lastRunError: result.error || null,
          lastRunDurationMs: result.durationMs,
          nextRunAt,
        })
        .where(eq(workflows.id, workflow.id));

      return { workflow, result };
    };

    // Process in batches of maxConcurrentWorkflows
    const results: PromiseSettledResult<{ workflow: typeof dueWorkflows[number]; result: Awaited<ReturnType<typeof executeWorkflow>> }>[] = [];
    for (let i = 0; i < dueWorkflows.length; i += maxConcurrentWorkflows) {
      const batch = dueWorkflows.slice(i, i + maxConcurrentWorkflows);
      const batchResults = await Promise.allSettled(batch.map(executeOne));
      results.push(...batchResults);
    }

    let executed = 0;
    const errors: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const settled = results[i];
      if (settled.status === 'fulfilled') {
        if (settled.value.result.success) {
          executed++;
        } else {
          errors.push(`${settled.value.workflow.name}: ${settled.value.result.error}`);
        }
      } else {
        const workflow = dueWorkflows[i];
        const errorMsg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        loggers.api.error(`Workflow cron: Failed for workflow ${workflow.id}`, { error: errorMsg });
        errors.push(`${workflow.name}: ${errorMsg}`);

        await db
          .update(workflows)
          .set({
            lastRunStatus: 'error',
            lastRunError: errorMsg,
            nextRunAt: getNextRunDate(workflow.cronExpression!, workflow.timezone),
          })
          .where(eq(workflows.id, workflow.id));
      }
    }

    loggers.api.info(`Workflow cron: Complete. Executed ${executed}/${dueWorkflows.length}`);

    return NextResponse.json({
      message: 'Workflow cron complete',
      executed,
      total: dueWorkflows.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    loggers.api.error('Workflow cron error:', error as Error);
    return NextResponse.json({ error: 'Workflow cron job failed' }, { status: 500 });
  }
}