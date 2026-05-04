import type { db as DbType } from '@pagespace/db/db';
import { eq, and, inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { workflows } from '@pagespace/db/schema/workflows';
import { calendarTriggers } from '@pagespace/db/schema/calendar-triggers';

const MAX_CONTEXT_PAGES = 10;

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
  }).returning({ id: workflows.id });

  const [createdTrigger] = await tx.insert(calendarTriggers).values({
    workflowId: createdWorkflow.id,
    calendarEventId,
    driveId,
    scheduledById,
    triggerAt,
  }).returning({ id: calendarTriggers.id });

  return { workflowId: createdWorkflow.id, triggerId: createdTrigger.id };
}

export interface ValidateCalendarAgentTriggerParams {
  driveId: string;
  agentTrigger: CalendarAgentTriggerInput;
}

/**
 * Pre-write validation for calendar agent triggers. Mirrors the checks
 * task-trigger-helpers does inline for tasks: at least a prompt or instruction
 * page, agent is an AI_CHAT in the same drive, instruction + context pages all
 * live in the same drive and aren't trashed, context list capped at 10.
 *
 * Both the REST POST and the AI create_calendar_event tool call this so the
 * two surfaces can never drift on what's accepted.
 */
export async function validateCalendarAgentTrigger(
  database: typeof DbType,
  params: ValidateCalendarAgentTriggerParams,
): Promise<{ agentPageId: string }> {
  const { driveId, agentTrigger } = params;
  const promptText = agentTrigger.prompt?.trim() ?? '';

  if (!promptText && !agentTrigger.instructionPageId) {
    throw new Error('Agent trigger needs either a prompt or instructionPageId');
  }

  const contextPageIds = agentTrigger.contextPageIds ?? [];
  if (contextPageIds.length > MAX_CONTEXT_PAGES) {
    throw new Error(`Agent trigger accepts at most ${MAX_CONTEXT_PAGES} context pages`);
  }

  const agent = await database.query.pages.findFirst({
    where: and(eq(pages.id, agentTrigger.agentPageId), eq(pages.type, 'AI_CHAT'), eq(pages.isTrashed, false)),
    columns: { id: true, driveId: true },
  });
  if (!agent) throw new Error('Agent page not found or not an AI agent');
  if (agent.driveId !== driveId) throw new Error('Agent must be in the same drive as the event');

  if (agentTrigger.instructionPageId) {
    const instrPage = await database.query.pages.findFirst({
      where: and(eq(pages.id, agentTrigger.instructionPageId), eq(pages.driveId, driveId), eq(pages.isTrashed, false)),
      columns: { id: true },
    });
    if (!instrPage) throw new Error('Instruction page not found or not in the same drive');
  }

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

  return { agentPageId: agent.id };
}

/**
 * Remove the agent trigger from a calendar event. Deletes the linked workflows
 * row(s); FK cascade drops the calendar_triggers rows. Treats a no-op
 * (no triggers exist) as success so callers don't need a pre-check.
 */
export async function removeCalendarTrigger(
  database: typeof DbType,
  calendarEventId: string,
): Promise<void> {
  const triggerRows = await database
    .select({ workflowId: calendarTriggers.workflowId })
    .from(calendarTriggers)
    .where(eq(calendarTriggers.calendarEventId, calendarEventId));

  if (triggerRows.length === 0) return;

  const workflowIds = triggerRows.map((r) => r.workflowId);
  await database.delete(workflows).where(inArray(workflows.id, workflowIds));
}

export interface UpsertCalendarTriggerWorkflowParams {
  driveId: string;
  scheduledById: string;
  calendarEventId: string;
  triggerAt: Date;
  timezone: string;
  agentTrigger: CalendarAgentTriggerInput;
}

/**
 * Upsert an event's agent trigger.
 *
 * If a trigger row already exists for this event, updates the linked workflows
 * row in place (agent / prompt / instruction / context pages) and re-aims
 * triggerAt — the workflowId stays stable so any historical workflow_runs
 * stays cleanly linked. If no trigger exists yet, falls through to
 * createCalendarTriggerWorkflow inside the same transaction.
 *
 * Validation runs before the transaction so a bad agent or off-drive context
 * page doesn't briefly hold a row lock.
 */
export async function upsertCalendarTriggerWorkflow(
  database: typeof DbType,
  params: UpsertCalendarTriggerWorkflowParams,
): Promise<{ workflowId: string; triggerId: string }> {
  await validateCalendarAgentTrigger(database, {
    driveId: params.driveId,
    agentTrigger: params.agentTrigger,
  });

  const triggerPrompt = params.agentTrigger.prompt?.trim() || 'Execute instructions from linked page.';
  const contextPageIds = params.agentTrigger.contextPageIds ?? [];

  return database.transaction(async (tx) => {
    const existing = await tx
      .select({ id: calendarTriggers.id, workflowId: calendarTriggers.workflowId })
      .from(calendarTriggers)
      .where(eq(calendarTriggers.calendarEventId, params.calendarEventId));

    if (existing.length > 0) {
      const { id: triggerId, workflowId } = existing[0];

      await tx.update(workflows).set({
        agentPageId: params.agentTrigger.agentPageId,
        prompt: triggerPrompt,
        instructionPageId: params.agentTrigger.instructionPageId ?? null,
        contextPageIds,
        timezone: params.timezone,
        isEnabled: true,
      }).where(eq(workflows.id, workflowId));

      await tx.update(calendarTriggers).set({
        triggerAt: params.triggerAt,
      }).where(eq(calendarTriggers.id, triggerId));

      return { workflowId, triggerId };
    }

    return createCalendarTriggerWorkflow({
      tx,
      driveId: params.driveId,
      scheduledById: params.scheduledById,
      calendarEventId: params.calendarEventId,
      triggerAt: params.triggerAt,
      timezone: params.timezone,
      agentTrigger: params.agentTrigger,
    });
  });
}
