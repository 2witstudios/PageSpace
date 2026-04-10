import { db, workflows, taskItems, pages, eq, and, inArray } from '@pagespace/db';
import { executeWorkflow } from './workflow-executor';
import { loggers } from '@pagespace/lib/server';

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
 * Create (or upsert) a task trigger workflow.
 * Validates agent page, instruction page, and context pages before inserting.
 * Uses onConflictDoUpdate on (taskItemId, triggerType) to handle duplicates.
 */
export async function createTaskTriggerWorkflow(params: CreateTaskTriggerWorkflowParams): Promise<void> {
  const { database, driveId, userId, taskId, taskMetadata, agentTrigger, dueDate, timezone } = params;
  const triggerType = agentTrigger.triggerType === 'completion' ? 'task_completion' as const : 'task_due_date' as const;

  if (triggerType === 'task_due_date' && !dueDate) {
    throw new Error('Due date is required for due_date triggers');
  }
  if (!agentTrigger.prompt && !agentTrigger.instructionPageId) {
    throw new Error('Agent trigger needs either a prompt or instructionPageId');
  }

  // Validate agent page
  const triggerAgent = await database.query.pages.findFirst({
    where: and(eq(pages.id, agentTrigger.agentPageId), eq(pages.type, 'AI_CHAT'), eq(pages.isTrashed, false)),
    columns: { id: true, driveId: true },
  });
  if (!triggerAgent) throw new Error('Agent trigger target not found or not an AI agent');
  if (triggerAgent.driveId !== driveId) throw new Error('Agent must be in the same drive as the task list');

  // Validate instruction page if provided
  if (agentTrigger.instructionPageId) {
    const instrPage = await database.query.pages.findFirst({
      where: and(eq(pages.id, agentTrigger.instructionPageId), eq(pages.driveId, driveId), eq(pages.isTrashed, false)),
      columns: { id: true },
    });
    if (!instrPage) throw new Error('Instruction page not found or not in the same drive');
  }

  // Validate context pages if provided
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
  const workflowData = {
    driveId,
    createdBy: userId,
    name: `task-trigger-${triggerType}-${taskId}`,
    agentPageId: agentTrigger.agentPageId,
    prompt: triggerPrompt,
    instructionPageId: agentTrigger.instructionPageId ?? null,
    contextPageIds,
    triggerType,
    taskItemId: taskId,
    timezone,
    isEnabled: true,
    nextRunAt: triggerType === 'task_due_date' && dueDate ? dueDate : null,
    lastRunStatus: 'never_run' as const,
  };

  await database.insert(workflows).values(workflowData).onConflictDoUpdate({
    target: [workflows.taskItemId, workflows.triggerType],
    set: {
      agentPageId: workflowData.agentPageId,
      prompt: workflowData.prompt,
      instructionPageId: workflowData.instructionPageId,
      contextPageIds: workflowData.contextPageIds,
      nextRunAt: workflowData.nextRunAt,
      isEnabled: true,
      lastRunStatus: 'never_run',
      lastRunError: null,
    },
  });

  // Mark task metadata
  await database.update(taskItems).set({
    metadata: {
      ...(taskMetadata || {}),
      hasTrigger: true,
      triggerType,
    },
  }).where(eq(taskItems.id, taskId));
}

/**
 * Update the nextRunAt for a task's due-date trigger when the due date changes.
 * Only affects pending (never_run) triggers.
 */
export async function syncTaskDueDateTrigger(taskId: string, newDueDate: Date | null): Promise<void> {
  try {
    if (newDueDate) {
      await db.update(workflows).set({ nextRunAt: newDueDate }).where(
        and(
          eq(workflows.taskItemId, taskId),
          eq(workflows.triggerType, 'task_due_date'),
          eq(workflows.isEnabled, true),
          eq(workflows.lastRunStatus, 'never_run'),
        ),
      );
    } else {
      // Due date cleared — disable the trigger
      await db.update(workflows).set({
        isEnabled: false,
        lastRunError: 'Due date cleared',
        nextRunAt: null,
      }).where(
        and(
          eq(workflows.taskItemId, taskId),
          eq(workflows.triggerType, 'task_due_date'),
          eq(workflows.isEnabled, true),
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
    await db.update(workflows).set({
      isEnabled: false,
      lastRunError: reason,
    }).where(
      and(
        eq(workflows.taskItemId, taskId),
        eq(workflows.triggerType, 'task_due_date'),
        eq(workflows.isEnabled, true),
        eq(workflows.lastRunStatus, 'never_run'),
      ),
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to cancel task due date trigger', { taskItemId: taskId, error: errorMsg });
  }
}

/**
 * Fire a task's completion trigger.
 * Uses .returning() on the claim UPDATE to prevent double-execution under concurrency.
 */
export async function fireCompletionTrigger(taskId: string): Promise<void> {
  try {
    const [completionWorkflow] = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.taskItemId, taskId),
          eq(workflows.triggerType, 'task_completion'),
          eq(workflows.isEnabled, true),
          eq(workflows.lastRunStatus, 'never_run'),
        ),
      );

    if (!completionWorkflow) return;

    // Atomically claim — only proceed if we actually updated a row
    // Re-check isEnabled to guard against concurrent disableTaskTriggers
    const claimed = await db.update(workflows).set({
      lastRunStatus: 'running',
      lastRunAt: new Date(),
    }).where(
      and(
        eq(workflows.id, completionWorkflow.id),
        eq(workflows.lastRunStatus, 'never_run'),
        eq(workflows.isEnabled, true),
      ),
    ).returning();

    if (claimed.length === 0) return; // Another caller already claimed it

    // Fire-and-forget execution with fully guarded promise chain
    void executeWorkflow(completionWorkflow).then(async (result) => {
      try {
        await db.update(workflows).set({
          lastRunStatus: result.success ? 'success' : 'error',
          lastRunError: result.error || null,
          lastRunDurationMs: result.durationMs,
          isEnabled: false,
        }).where(eq(workflows.id, completionWorkflow.id));
      } catch (dbErr) {
        logger.error('Failed to update workflow status after execution', {
          workflowId: completionWorkflow.id,
          error: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
      }

      logger.info('Completion trigger executed', {
        workflowId: completionWorkflow.id,
        taskItemId: taskId,
        success: result.success,
        durationMs: result.durationMs,
      });
    }).catch(async (err) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Completion trigger execution failed', {
        workflowId: completionWorkflow.id,
        taskItemId: taskId,
        error: errorMsg,
      });
      try {
        await db.update(workflows).set({
          lastRunStatus: 'error',
          lastRunError: errorMsg,
          isEnabled: false,
        }).where(eq(workflows.id, completionWorkflow.id));
      } catch (dbErr) {
        logger.error('Failed to update workflow error status', {
          workflowId: completionWorkflow.id,
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
 * Disable all task trigger workflows for a given task.
 * Used when a task is deleted or trashed.
 */
export async function disableTaskTriggers(taskId: string, reason: string): Promise<void> {
  try {
    await db.update(workflows).set({
      isEnabled: false,
      lastRunError: reason,
    }).where(
      and(
        eq(workflows.taskItemId, taskId),
        eq(workflows.isEnabled, true),
      ),
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to disable task triggers', { taskItemId: taskId, error: errorMsg });
  }
}
