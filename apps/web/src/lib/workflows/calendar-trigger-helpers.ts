import type { db as DbType } from '@pagespace/db/db';
import { eq, and, inArray, ne, gt, sql } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { workflows } from '@pagespace/db/schema/workflows';
import { calendarTriggers } from '@pagespace/db/schema/calendar-triggers';
import { workflowRuns } from '@pagespace/db/schema/workflow-runs';
import { expandOccurrences, type RecurrenceRule } from './recurrence-utils';

const MAX_CONTEXT_PAGES = 10;
const TRIGGER_HORIZON_DAYS = 180;

type DbOrTx = typeof DbType | Parameters<Parameters<typeof DbType.transaction>[0]>[0];

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
  occurrenceDate?: Date;
  timezone: string;
  agentTrigger: CalendarAgentTriggerInput;
}

/**
 * Atomically write the workflows row (execution payload) and a single
 * calendar_triggers row inside a caller-supplied transaction. Used for
 * one-shot (non-recurring) events. Pass occurrenceDate when creating an
 * individual occurrence row for a recurring event (e.g. the refill path).
 * Validation is the caller's responsibility.
 */
export async function createCalendarTriggerWorkflow(
  params: CreateCalendarTriggerWorkflowParams,
): Promise<{ workflowId: string; triggerId: string }> {
  const { tx, driveId, scheduledById, calendarEventId, triggerAt, occurrenceDate, timezone, agentTrigger } = params;
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
    ...(occurrenceDate ? { occurrenceDate } : {}),
  }).returning({ id: calendarTriggers.id });

  return { workflowId: createdWorkflow.id, triggerId: createdTrigger.id };
}

/**
 * Batch-insert one calendar_triggers row per occurrence date. All rows share
 * the same workflowId (the workflows row is already written by the caller).
 * Uses ON CONFLICT DO NOTHING — safe to call repeatedly for the same event;
 * already-fired occurrences are not re-inserted.
 */
export async function bulkCreateOccurrenceTriggerRows(
  database: DbOrTx,
  params: {
    workflowId: string;
    calendarEventId: string;
    driveId: string;
    scheduledById: string;
    occurrences: Date[];
  },
): Promise<void> {
  if (params.occurrences.length === 0) return;

  await database
    .insert(calendarTriggers)
    .values(
      params.occurrences.map((date) => ({
        workflowId: params.workflowId,
        calendarEventId: params.calendarEventId,
        driveId: params.driveId,
        scheduledById: params.scheduledById,
        triggerAt: date,
        occurrenceDate: date,
      })),
    )
    .onConflictDoNothing();
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
  database: DbOrTx,
  calendarEventId: string,
): Promise<void> {
  const triggerRows = await database
    .select({ workflowId: calendarTriggers.workflowId })
    .from(calendarTriggers)
    .where(eq(calendarTriggers.calendarEventId, calendarEventId));

  if (triggerRows.length === 0) return;

  const workflowIds = [...new Set(triggerRows.map((r) => r.workflowId))];
  await database.delete(workflows).where(inArray(workflows.id, workflowIds));
}

export interface UpsertCalendarTriggerWorkflowParams {
  driveId: string;
  scheduledById: string;
  calendarEventId: string;
  triggerAt: Date;
  timezone: string;
  agentTrigger: CalendarAgentTriggerInput;
  recurrenceRule?: RecurrenceRule | null;
  recurrenceExceptions?: string[];
}

/**
 * In-tx upsert. Caller must pre-validate via validateCalendarAgentTrigger.
 *
 * For recurring events (recurrenceRule non-null):
 *   - Upserts the single workflows row (stable workflowId preserves history).
 *   - Deletes all unfired future trigger rows (so recurrence-rule or time-of-day
 *     changes take effect cleanly).
 *   - Bulk-inserts occurrence rows for the next 180 days via
 *     bulkCreateOccurrenceTriggerRows (ON CONFLICT DO NOTHING = idempotent).
 *
 * For one-shot events (recurrenceRule null/absent):
 *   - Updates the existing trigger row's triggerAt, or creates one if absent.
 */
export async function upsertCalendarTriggerWorkflowInTx(
  tx: Parameters<Parameters<typeof DbType.transaction>[0]>[0],
  params: UpsertCalendarTriggerWorkflowParams,
): Promise<{ workflowId: string; triggerId: string }> {
  const triggerPrompt = params.agentTrigger.prompt?.trim() || 'Execute instructions from linked page.';
  const contextPageIds = params.agentTrigger.contextPageIds ?? [];

  const existing = await tx
    .select({ id: calendarTriggers.id, workflowId: calendarTriggers.workflowId })
    .from(calendarTriggers)
    .where(eq(calendarTriggers.calendarEventId, params.calendarEventId));

  let workflowId: string;

  if (existing.length > 0) {
    workflowId = existing[0].workflowId;
    await tx.update(workflows).set({
      agentPageId: params.agentTrigger.agentPageId,
      prompt: triggerPrompt,
      instructionPageId: params.agentTrigger.instructionPageId ?? null,
      contextPageIds,
      timezone: params.timezone,
      isEnabled: true,
    }).where(eq(workflows.id, workflowId));
  } else {
    const [created] = await tx.insert(workflows).values({
      driveId: params.driveId,
      createdBy: params.scheduledById,
      name: `calendar-trigger-${params.calendarEventId}`,
      agentPageId: params.agentTrigger.agentPageId,
      prompt: triggerPrompt,
      instructionPageId: params.agentTrigger.instructionPageId ?? null,
      contextPageIds,
      triggerType: 'cron',
      timezone: params.timezone,
      isEnabled: true,
    }).returning({ id: workflows.id });
    workflowId = created.id;
  }

  if (params.recurrenceRule) {
    // Clean up unfired future occurrence rows before recreating — ensures that
    // recurrence-rule changes (e.g. weekly → daily) or time-of-day changes
    // take effect immediately rather than leaving stale rows in the queue.
    const now = new Date();
    await tx.delete(calendarTriggers).where(
      and(
        eq(calendarTriggers.calendarEventId, params.calendarEventId),
        gt(calendarTriggers.triggerAt, now),
        sql`NOT EXISTS (
          SELECT 1 FROM ${workflowRuns}
          WHERE ${workflowRuns.sourceTable} = 'calendarTriggers'
            AND ${workflowRuns.sourceId} = ${calendarTriggers.id}
        )`,
      ),
    );

    const horizon = new Date(now.getTime() + TRIGGER_HORIZON_DAYS * 86_400_000);
    const occurrences = expandOccurrences(
      params.recurrenceRule,
      params.triggerAt,
      now,
      horizon,
      params.recurrenceExceptions ?? [],
    );

    await bulkCreateOccurrenceTriggerRows(tx, {
      workflowId,
      calendarEventId: params.calendarEventId,
      driveId: params.driveId,
      scheduledById: params.scheduledById,
      occurrences,
    });

    return { workflowId, triggerId: '' };
  }

  // One-shot path: clean up any leftover occurrence rows (from a previous
  // recurring configuration), then update or create the single trigger row.
  if (existing.length > 0) {
    // Delete all unfired rows for this event except the one we'll update.
    // This removes stale occurrence rows when a recurring event becomes one-shot.
    await tx.delete(calendarTriggers).where(
      and(
        eq(calendarTriggers.calendarEventId, params.calendarEventId),
        ne(calendarTriggers.id, existing[0].id),
        sql`NOT EXISTS (
          SELECT 1 FROM ${workflowRuns}
          WHERE ${workflowRuns.sourceTable} = 'calendarTriggers'
            AND ${workflowRuns.sourceId} = ${calendarTriggers.id}
        )`,
      ),
    );
    await tx.update(calendarTriggers).set({
      triggerAt: params.triggerAt,
    }).where(eq(calendarTriggers.id, existing[0].id));
    return { workflowId, triggerId: existing[0].id };
  }

  const [created] = await tx.insert(calendarTriggers).values({
    workflowId,
    calendarEventId: params.calendarEventId,
    driveId: params.driveId,
    scheduledById: params.scheduledById,
    triggerAt: params.triggerAt,
  }).returning({ id: calendarTriggers.id });

  return { workflowId, triggerId: created.id };
}

/**
 * Upsert an event's agent trigger (standalone, outside an existing transaction).
 *
 * Validation runs before the transaction so a bad agent or off-drive context
 * page doesn't briefly hold a row lock. Used by the standalone PUT /triggers
 * endpoint; PATCH event uses upsertCalendarTriggerWorkflowInTx instead so its
 * event update and trigger upsert commit atomically.
 */
export async function upsertCalendarTriggerWorkflow(
  database: typeof DbType,
  params: UpsertCalendarTriggerWorkflowParams,
): Promise<{ workflowId: string; triggerId: string }> {
  await validateCalendarAgentTrigger(database, {
    driveId: params.driveId,
    agentTrigger: params.agentTrigger,
  });

  return database.transaction((tx) => upsertCalendarTriggerWorkflowInTx(tx, params));
}

/**
 * Re-synchronise trigger rows when the event's timing or recurrence rule changes
 * but the caller did NOT explicitly supply a new agentTrigger payload.
 *
 * For recurring events: deletes unfired future rows and re-expands the series
 * from newBaseAt using the caller-supplied recurrenceRule, preserving the
 * existing workflowId so history stays linked.
 *
 * For one-shot events: re-aims the single pending trigger row to newBaseAt.
 *
 * No-op if the event has no trigger rows at all.
 */
export async function resyncCalendarTriggerTimings(
  tx: Parameters<Parameters<typeof DbType.transaction>[0]>[0],
  calendarEventId: string,
  newBaseAt: Date,
  effectiveRecurrenceRule: RecurrenceRule | null | undefined,
  exceptions: string[],
): Promise<void> {
  if (effectiveRecurrenceRule) {
    const existingTrigger = await tx
      .select({
        workflowId: calendarTriggers.workflowId,
        driveId: calendarTriggers.driveId,
        scheduledById: calendarTriggers.scheduledById,
      })
      .from(calendarTriggers)
      .where(eq(calendarTriggers.calendarEventId, calendarEventId));

    if (existingTrigger.length === 0) return;

    const { workflowId, driveId, scheduledById } = existingTrigger[0];
    const now = new Date();
    await tx.delete(calendarTriggers).where(
      and(
        eq(calendarTriggers.calendarEventId, calendarEventId),
        gt(calendarTriggers.triggerAt, now),
        sql`NOT EXISTS (
          SELECT 1 FROM ${workflowRuns}
          WHERE ${workflowRuns.sourceTable} = 'calendarTriggers'
            AND ${workflowRuns.sourceId} = ${calendarTriggers.id}
        )`,
      ),
    );

    const horizon = new Date(now.getTime() + TRIGGER_HORIZON_DAYS * 86_400_000);
    const occurrences = expandOccurrences(
      effectiveRecurrenceRule,
      newBaseAt,
      now,
      horizon,
      exceptions,
    );

    await bulkCreateOccurrenceTriggerRows(tx, {
      workflowId,
      calendarEventId,
      driveId,
      scheduledById,
      occurrences,
    });
  } else {
    await tx
      .update(calendarTriggers)
      .set({ triggerAt: newBaseAt })
      .where(and(
        eq(calendarTriggers.calendarEventId, calendarEventId),
        sql`NOT EXISTS (
          SELECT 1 FROM ${workflowRuns}
          WHERE ${workflowRuns.sourceTable} = 'calendarTriggers'
            AND ${workflowRuns.sourceId} = ${calendarTriggers.id}
        )`,
      ));
  }
}
