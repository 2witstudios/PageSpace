import { db } from '@pagespace/db/db'
import { eq, and, inArray, isNull } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { taskItems } from '@pagespace/db/schema/tasks'
import { workflows } from '@pagespace/db/schema/workflows';
import { taskTriggers } from '@pagespace/db/schema/task-triggers';
import { executeWorkflow, type WorkflowExecutionInput } from './workflow-executor';
import { loggers } from '@pagespace/lib/logging/logger-config';

export interface AgentTriggerInput {
  agentPageId: string;
  prompt?: string;
  instructionPageId?: string;
  contextPageIds?: string[];
  triggerType: 'due_date' | 'completion';
}

export interface CreateTaskTriggerWorkflowParams {
  database: typeof db;
  driveId: string;
  userId: string;
  taskId: string;
  taskMetadata: Record<string, unknown> | null;
  agentTrigger: AgentTriggerInput;
  dueDate: Date | null;
  timezone: string;
}

const logger = loggers.api.child({ module: 'task-trigger-helpers' });

/**
 * Recompute taskItems.metadata.triggerTypes / hasTrigger from the live taskTriggers table.
 * Use this after any insert/upsert/disable so metadata never drifts from DB truth — in
 * particular it stays correct when an agent page cascade-deletes a workflow row, which
 * cascades to its task_triggers row, without touching the task itself.
 */
export async function recomputeTaskTriggerMetadata(
  database: typeof db,
  taskId: string,
  baseMetadata: Record<string, unknown> | null,
): Promise<void> {
  const rows = await database
    .select({ triggerType: taskTriggers.triggerType })
    .from(taskTriggers)
    .where(and(
      eq(taskTriggers.taskItemId, taskId),
      eq(taskTriggers.isEnabled, true),
    ));
  const triggerTypes = Array.from(new Set(rows.map((r) => r.triggerType)));
  await database.update(taskItems).set({
    metadata: {
      ...(baseMetadata ?? {}),
      triggerTypes,
      hasTrigger: triggerTypes.length > 0,
    },
  }).where(eq(taskItems.id, taskId));
}

/**
 * Create (or upsert) a task trigger.
 * Validates agent page, instruction page, and context pages, then atomically writes
 * one workflows row (execution payload) and one task_triggers row (the "when") in
 * a transaction. Uses onConflictDoUpdate on task_triggers (taskItemId, triggerType)
 * to handle duplicates — the matching workflows row is updated in-place.
 */
export async function createTaskTriggerWorkflow(params: CreateTaskTriggerWorkflowParams): Promise<void> {
  const { database, driveId, userId, taskId, taskMetadata, agentTrigger, dueDate, timezone } = params;
  const triggerType = agentTrigger.triggerType;

  if (triggerType === 'due_date' && !dueDate) {
    throw new Error('Due date is required for due_date triggers');
  }
  if (!agentTrigger.prompt && !agentTrigger.instructionPageId) {
    throw new Error('Agent trigger needs either a prompt or instructionPageId');
  }

  const triggerAgent = await database.query.pages.findFirst({
    where: and(eq(pages.id, agentTrigger.agentPageId), eq(pages.type, 'AI_CHAT'), eq(pages.isTrashed, false)),
    columns: { id: true, driveId: true },
  });
  if (!triggerAgent) throw new Error('Agent trigger target not found or not an AI agent');
  if (triggerAgent.driveId !== driveId) throw new Error('Agent must be in the same drive as the task list');

  if (agentTrigger.instructionPageId) {
    const instrPage = await database.query.pages.findFirst({
      where: and(eq(pages.id, agentTrigger.instructionPageId), eq(pages.driveId, driveId), eq(pages.isTrashed, false)),
      columns: { id: true },
    });
    if (!instrPage) throw new Error('Instruction page not found or not in the same drive');
  }

  const contextPageIds = agentTrigger.contextPageIds ?? [];
  if (contextPageIds.length > 0) {
    const validPages = await database.query.pages.findMany({
      where: and(
        inArray(pages.id, contextPageIds),
        eq(pages.driveId, driveId),
        eq(pages.isTrashed, false),
      ),
      columns: { id: true },
    });
    if (validPages.length !== contextPageIds.length) {
      throw new Error('Some context pages were not found or are not in the same drive');
    }
  }

  const triggerPrompt = agentTrigger.prompt || 'Execute instructions from linked page.';
  const nextRunAt = triggerType === 'due_date' && dueDate ? dueDate : null;

  await database.transaction(async (tx) => {
    const existing = await tx
      .select({ workflowId: taskTriggers.workflowId })
      .from(taskTriggers)
      .where(and(
        eq(taskTriggers.taskItemId, taskId),
        eq(taskTriggers.triggerType, triggerType),
      ));

    if (existing.length > 0) {
      const workflowId = existing[0].workflowId;
      await tx.update(workflows).set({
        agentPageId: agentTrigger.agentPageId,
        prompt: triggerPrompt,
        instructionPageId: agentTrigger.instructionPageId ?? null,
        contextPageIds,
        timezone,
        isEnabled: true,
        lastRunStatus: 'never_run',
        lastRunError: null,
      }).where(eq(workflows.id, workflowId));

      await tx.update(taskTriggers).set({
        nextRunAt,
        lastFiredAt: null,
        lastFireError: null,
        isEnabled: true,
      }).where(and(
        eq(taskTriggers.taskItemId, taskId),
        eq(taskTriggers.triggerType, triggerType),
      ));
    } else {
      const [createdWorkflow] = await tx.insert(workflows).values({
        driveId,
        createdBy: userId,
        name: `task-trigger-${triggerType}-${taskId}`,
        agentPageId: agentTrigger.agentPageId,
        prompt: triggerPrompt,
        instructionPageId: agentTrigger.instructionPageId ?? null,
        contextPageIds,
        triggerType: 'cron',
        timezone,
        isEnabled: true,
        lastRunStatus: 'never_run',
      }).returning({ id: workflows.id });

      await tx.insert(taskTriggers).values({
        workflowId: createdWorkflow.id,
        taskItemId: taskId,
        triggerType,
        nextRunAt,
        isEnabled: true,
      });
    }
  });

  await recomputeTaskTriggerMetadata(database, taskId, taskMetadata);
}

/**
 * Update the nextRunAt for a task's due-date trigger when the due date changes.
 * Only affects rows that haven't fired yet (lastFiredAt IS NULL).
 */
export async function syncTaskDueDateTrigger(taskId: string, newDueDate: Date | null): Promise<void> {
  try {
    if (newDueDate) {
      await db.update(taskTriggers).set({ nextRunAt: newDueDate }).where(
        and(
          eq(taskTriggers.taskItemId, taskId),
          eq(taskTriggers.triggerType, 'due_date'),
          eq(taskTriggers.isEnabled, true),
          isNull(taskTriggers.lastFiredAt),
        ),
      );
    } else {
      await db.update(taskTriggers).set({
        isEnabled: false,
        lastFireError: 'Due date cleared',
        nextRunAt: null,
      }).where(
        and(
          eq(taskTriggers.taskItemId, taskId),
          eq(taskTriggers.triggerType, 'due_date'),
          eq(taskTriggers.isEnabled, true),
          isNull(taskTriggers.lastFiredAt),
        ),
      );
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to sync task due date trigger', { taskItemId: taskId, error: errorMsg });
  }
}

/**
 * Cancel a task's pending due-date trigger with a reason.
 */
export async function cancelTaskDueDateTrigger(taskId: string, reason: string): Promise<void> {
  try {
    await db.update(taskTriggers).set({
      isEnabled: false,
      lastFireError: reason,
    }).where(
      and(
        eq(taskTriggers.taskItemId, taskId),
        eq(taskTriggers.triggerType, 'due_date'),
        eq(taskTriggers.isEnabled, true),
        isNull(taskTriggers.lastFiredAt),
      ),
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to cancel task due date trigger', { taskItemId: taskId, error: errorMsg });
  }
}

/**
 * Fire a task's completion trigger.
 * Atomically claims the matching task_triggers row (lastFiredAt IS NULL guard) so
 * one fire ever happens per row, then loads the linked workflow and executes it.
 */
export async function fireCompletionTrigger(taskId: string): Promise<void> {
  try {
    const [completionTrigger] = await db
      .select()
      .from(taskTriggers)
      .where(
        and(
          eq(taskTriggers.taskItemId, taskId),
          eq(taskTriggers.triggerType, 'completion'),
          eq(taskTriggers.isEnabled, true),
        ),
      );

    if (!completionTrigger || completionTrigger.lastFiredAt !== null) return;

    const claimed = await db.update(taskTriggers).set({
      lastFiredAt: new Date(),
    }).where(
      and(
        eq(taskTriggers.id, completionTrigger.id),
        eq(taskTriggers.isEnabled, true),
      ),
    ).returning();

    if (claimed.length === 0) return;

    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, completionTrigger.workflowId));

    if (!workflow) {
      await db.update(taskTriggers).set({
        isEnabled: false,
        lastFireError: 'Linked workflow not found',
      }).where(eq(taskTriggers.id, completionTrigger.id));
      return;
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
      taskContext: { taskItemId: taskId, triggerType: 'completion' },
    };

    void executeWorkflow(input).then(async (result) => {
      try {
        await db.update(taskTriggers).set({
          lastFireError: result.error || null,
          isEnabled: false,
        }).where(eq(taskTriggers.id, completionTrigger.id));
      } catch (dbErr) {
        logger.error('Failed to update task_trigger after execution', {
          triggerId: completionTrigger.id,
          error: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
      }

      logger.info('Completion trigger executed', {
        triggerId: completionTrigger.id,
        workflowId: workflow.id,
        taskItemId: taskId,
        success: result.success,
        durationMs: result.durationMs,
      });
    }).catch(async (err) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Completion trigger execution failed', {
        triggerId: completionTrigger.id,
        workflowId: workflow.id,
        taskItemId: taskId,
        error: errorMsg,
      });
      try {
        await db.update(taskTriggers).set({
          lastFireError: errorMsg,
          isEnabled: false,
        }).where(eq(taskTriggers.id, completionTrigger.id));
      } catch (dbErr) {
        logger.error('Failed to update task_trigger error status', {
          triggerId: completionTrigger.id,
          error: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
      }
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to fire completion trigger', { taskItemId: taskId, error: errorMsg });
  }
}

/**
 * Disable all task triggers for a given task and delete their linked workflows
 * rows. Used when a task is deleted or trashed. The workflows row is the
 * execution definition; once no trigger references it, it's garbage — explicit
 * cleanup keeps the workflows table free of orphans (cascade goes the other
 * way: deleting a workflow cascades to its task_triggers row, but the inverse
 * is what we need here).
 */
export async function disableTaskTriggers(taskId: string, reason: string): Promise<void> {
  try {
    const triggerRows = await db
      .select({ id: taskTriggers.id, workflowId: taskTriggers.workflowId })
      .from(taskTriggers)
      .where(eq(taskTriggers.taskItemId, taskId));

    if (triggerRows.length === 0) return;

    await db.update(taskTriggers).set({
      isEnabled: false,
      lastFireError: reason,
    }).where(eq(taskTriggers.taskItemId, taskId));

    const workflowIds = triggerRows.map(r => r.workflowId);
    await db.delete(workflows).where(inArray(workflows.id, workflowIds));
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to disable task triggers', { taskItemId: taskId, error: errorMsg });
  }
}
