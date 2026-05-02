import type { db as DbType } from '@pagespace/db/db';
import { workflows } from '@pagespace/db/schema/workflows';
import { calendarTriggers } from '@pagespace/db/schema/calendar-triggers';

export interface CalendarAgentTriggerInput {
  agentPageId: string;
  prompt?: string;
  instructionPageId?: string | null;
  contextPageIds?: string[];
}

export interface CreateCalendarTriggerWorkflowParams {
  tx: Parameters<Parameters<typeof DbType.transaction>[0]>[0];
  driveId: string;
  scheduledById: string;
  calendarEventId: string;
  triggerAt: Date;
  timezone: string;
  agentTrigger: CalendarAgentTriggerInput;
}

/**
 * Atomically write the workflows row (execution payload) and the
 * calendar_triggers row (the "when") inside a caller-supplied transaction.
 * Validation of the agent / instruction / context pages is the caller's
 * responsibility — by this point those checks must have passed.
 */
export async function createCalendarTriggerWorkflow(
  params: CreateCalendarTriggerWorkflowParams,
): Promise<{ workflowId: string; triggerId: string }> {
  const { tx, driveId, scheduledById, calendarEventId, triggerAt, timezone, agentTrigger } = params;
  const triggerPrompt = agentTrigger.prompt || 'Execute instructions from linked page.';

  const [createdWorkflow] = await tx.insert(workflows).values({
    driveId,
    createdBy: scheduledById,
    name: `calendar-trigger-${calendarEventId}`,
    agentPageId: agentTrigger.agentPageId,
    prompt: triggerPrompt,
    instructionPageId: agentTrigger.instructionPageId ?? null,
    contextPageIds: agentTrigger.contextPageIds ?? [],
    triggerType: 'cron',
    timezone,
    isEnabled: true,
    lastRunStatus: 'never_run',
  }).returning({ id: workflows.id });

  const [createdTrigger] = await tx.insert(calendarTriggers).values({
    workflowId: createdWorkflow.id,
    calendarEventId,
    driveId,
    scheduledById,
    status: 'pending',
    triggerAt,
  }).returning({ id: calendarTriggers.id });

  return { workflowId: createdWorkflow.id, triggerId: createdTrigger.id };
}
