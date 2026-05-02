import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq, and, lte, inArray, isNull, asc } from '@pagespace/db/operators'
import { workflows } from '@pagespace/db/schema/workflows';
import { taskTriggers } from '@pagespace/db/schema/task-triggers';
import { taskItems } from '@pagespace/db/schema/tasks';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { executeWorkflow, type WorkflowExecutionInput } from '@/lib/workflows/workflow-executor';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { audit } from '@pagespace/lib/audit/audit-log';

const MAX_CONCURRENT_TRIGGERS = 5;
const MAX_DUE_TRIGGERS = 50;

const logger = loggers.api.child({ module: 'cron-task-triggers' });

/**
 * POST /api/cron/task-triggers — fire due task triggers (one-shot, due_date).
 *
 * Picks task_triggers rows where isEnabled = true, nextRunAt <= NOW(),
 * lastFiredAt IS NULL. Atomically claims by setting lastFiredAt = NOW()
 * with a returning() clause so concurrent invocations cannot double-fire,
 * then loads the linked workflow and pre-checks the underlying task before
 * executing.
 */
export async function POST(req: Request) {
  const authError = validateSignedCronRequest(req);
  if (authError) return authError;

  try {
    const now = new Date();

    const dueTriggers = await db
      .select()
      .from(taskTriggers)
      .where(
        and(
          eq(taskTriggers.isEnabled, true),
          lte(taskTriggers.nextRunAt, now),
          isNull(taskTriggers.lastFiredAt),
        ),
      )
      .orderBy(asc(taskTriggers.nextRunAt))
      .limit(MAX_DUE_TRIGGERS);

    if (dueTriggers.length === 0) {
      audit({ eventType: 'data.write', resourceType: 'cron_job', resourceId: 'task_triggers', details: { executed: 0, failed: 0 } });
      return NextResponse.json({ message: 'No task triggers due', executed: 0 });
    }

    logger.info(`Task trigger cron: Found ${dueTriggers.length} due triggers`);

    let executed = 0;
    let totalClaimed = 0;
    const errors: string[] = [];

    for (let i = 0; i < dueTriggers.length; i += MAX_CONCURRENT_TRIGGERS) {
      const batch = dueTriggers.slice(i, i + MAX_CONCURRENT_TRIGGERS);
      const batchIds = batch.map(t => t.id);

      // Atomically claim: lastFiredAt IS NULL guard prevents double-fire
      const claimed = await db
        .update(taskTriggers)
        .set({ lastFiredAt: now })
        .where(
          and(
            inArray(taskTriggers.id, batchIds),
            eq(taskTriggers.isEnabled, true),
            isNull(taskTriggers.lastFiredAt),
            lte(taskTriggers.nextRunAt, now),
          ),
        )
        .returning();

      if (claimed.length === 0) continue;
      totalClaimed += claimed.length;

      // Load linked workflows
      const workflowIds = [...new Set(claimed.map(t => t.workflowId))];
      const linkedWorkflows = await db
        .select()
        .from(workflows)
        .where(inArray(workflows.id, workflowIds));
      const workflowMap = new Map(linkedWorkflows.map(w => [w.id, w]));

      // Load linked tasks (for pre-execution skip check on due_date triggers)
      const taskIds = [...new Set(claimed.map(t => t.taskItemId))];
      const tasks = await db
        .select({ id: taskItems.id, completedAt: taskItems.completedAt, dueDate: taskItems.dueDate })
        .from(taskItems)
        .where(inArray(taskItems.id, taskIds));
      const taskMap = new Map(tasks.map(t => [t.id, t]));

      const batchResults = await Promise.allSettled(
        claimed.map(async (trigger) => {
          const workflow = workflowMap.get(trigger.workflowId);
          if (!workflow) {
            await db.update(taskTriggers).set({
              isEnabled: false,
              lastFireError: 'Linked workflow not found',
            }).where(eq(taskTriggers.id, trigger.id));
            return { trigger, result: { success: false, durationMs: 0, error: 'Linked workflow not found' } as const };
          }

          // Pre-execution skip for due_date triggers whose task became ineligible
          if (trigger.triggerType === 'due_date') {
            const task = taskMap.get(trigger.taskItemId);
            const skipReason = !task
              ? 'Task not found'
              : task.completedAt
                ? 'Task completed before due date'
                : (!task.dueDate || task.dueDate.getTime() > now.getTime())
                  ? 'Task due date cleared or postponed'
                  : null;

            if (skipReason) {
              await db.update(taskTriggers).set({
                isEnabled: false,
                lastFireError: skipReason,
              }).where(eq(taskTriggers.id, trigger.id));
              return { trigger, result: { success: false, durationMs: 0, error: skipReason } as const };
            }
          }

          const input: WorkflowExecutionInput = {
            workflowId: workflow.id,
            workflowName: workflow.name,
            driveId: workflow.driveId,
            createdBy: workflow.createdBy,
            agentPageId: workflow.agentPageId,
            prompt: workflow.prompt,
            contextPageIds: (workflow.contextPageIds as string[] | null) ?? [],
            instructionPageId: workflow.instructionPageId,
            timezone: workflow.timezone,
            taskContext: { taskItemId: trigger.taskItemId, triggerType: trigger.triggerType },
          };

          const result = await executeWorkflow(input);

          await db.update(taskTriggers).set({
            isEnabled: false,
            lastFireError: result.error || null,
          }).where(eq(taskTriggers.id, trigger.id));

          return { trigger, result };
        }),
      );

      for (let j = 0; j < batchResults.length; j++) {
        const settled = batchResults[j];
        if (settled.status === 'fulfilled') {
          if (settled.value.result.success) {
            executed++;
          } else {
            errors.push(`task-trigger-${settled.value.trigger.id}: ${settled.value.result.error}`);
          }
        } else {
          const trigger = claimed[j];
          const errorMsg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
          logger.error('Task trigger execution rejected', { triggerId: trigger.id, error: errorMsg });
          errors.push(`task-trigger-${trigger.id}: ${errorMsg}`);

          await db.update(taskTriggers).set({
            isEnabled: false,
            lastFireError: errorMsg,
          }).where(eq(taskTriggers.id, trigger.id));
        }
      }
    }

    logger.info(`Task trigger cron: Complete. Executed ${executed}/${totalClaimed}`);

    audit({ eventType: 'data.write', resourceType: 'cron_job', resourceId: 'task_triggers', details: { executed, failed: errors.length } });

    return NextResponse.json({
      message: 'Task trigger cron complete',
      executed,
      total: totalClaimed,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    logger.error('Task trigger cron error:', error as Error);
    return NextResponse.json({ error: 'Task trigger cron job failed' }, { status: 500 });
  }
}
