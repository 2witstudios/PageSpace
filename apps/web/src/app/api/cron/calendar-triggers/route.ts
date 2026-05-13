import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq, and, lte, inArray, asc, sql, isNotNull } from '@pagespace/db/operators'
import { calendarEvents } from '@pagespace/db/schema/calendar'
import { calendarTriggers } from '@pagespace/db/schema/calendar-triggers';
import { workflowRuns } from '@pagespace/db/schema/workflow-runs';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { executeCalendarTrigger } from '@/lib/workflows/calendar-trigger-executor';
import { bulkCreateOccurrenceTriggerRows } from '@/lib/workflows/calendar-trigger-helpers';
import { expandOccurrences } from '@/lib/workflows/recurrence-utils';
import type { WorkflowExecutionResult } from '@/lib/workflows/workflow-executor';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { audit } from '@pagespace/lib/audit/audit-log';

const STUCK_RUN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CONCURRENT_TRIGGERS = 5;
const MAX_DUE_TRIGGERS = 50;
const REFILL_MAX_EVENTS = 20;
const REFILL_LOOKAHEAD_DAYS = 30;
const REFILL_HORIZON_DAYS = 180;

const logger = loggers.api.child({ module: 'cron-calendar-triggers' });

/**
 * POST /api/cron/calendar-triggers — fire due calendar triggers (one-shot).
 *
 * Discovery: calendar_triggers rows where triggerAt <= NOW() AND no
 * workflow_runs row exists at all for them. Calendar triggers are
 * one-shot per occurrence, so any prior outcome (running / success /
 * error / cancelled) is terminal. Per-fire state (status, timings,
 * error, durationMs, conversationId) lives on workflow_runs —
 * calendar_triggers no longer carries any per-fire columns. Atomic
 * claim is the workflow_runs partial unique index inside the executor,
 * not state on the trigger row.
 *
 * Stuck-run sweep now targets workflow_runs.status='running' rows older
 * than STUCK_RUN_TIMEOUT_MS — one place to look for any workflow domain.
 */
export async function POST(req: Request) {
  const authError = validateSignedCronRequest(req);
  if (authError) return authError;

  try {
    const now = new Date();

    // 1. Reset stuck workflow_runs rows (running > 10 min) regardless of source domain.
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

    // 2. Find pending calendar triggers — those with triggerAt due AND no workflow_runs
    //    row in any terminal-or-active state for them. The NOT EXISTS subquery uses
    //    the (sourceTable, sourceId, status) index for a fast lookup.
    //
    //    Calendar triggers are one-shot (one row per occurrence); any terminal
    //    status — success, error, cancelled, or in-flight running — means we
    //    don't re-fire. This matches the original `status='pending'` semantics
    //    on the dropped column. Without 'cancelled' here, every cron tick
    //    re-discovered trashed-event triggers and accumulated audit rows.
    const dueTriggers = await db
      .select()
      .from(calendarTriggers)
      .where(and(
        lte(calendarTriggers.triggerAt, now),
        sql`NOT EXISTS (
          SELECT 1 FROM ${workflowRuns}
          WHERE ${workflowRuns.sourceTable} = 'calendarTriggers'
            AND ${workflowRuns.sourceId} = ${calendarTriggers.id}
        )`,
      ))
      .orderBy(asc(calendarTriggers.triggerAt))
      .limit(MAX_DUE_TRIGGERS);

    if (dueTriggers.length === 0) {
      await refillRecurringTriggers(now);
      audit({ eventType: 'data.write', resourceType: 'cron_job', resourceId: 'calendar_triggers', details: { executed: 0, failed: 0 } });
      return NextResponse.json({ message: 'No calendar triggers due', executed: 0 });
    }

    logger.info(`Calendar trigger cron: Found ${dueTriggers.length} due triggers`);

    let executed = 0;
    let totalAttempted = 0;
    const errors: string[] = [];

    // 3. Process in batches. The atomic claim happens inside the executor via
    //    workflow_runs's partial unique index — concurrent invocations losing
    //    the race get claimConflict back and skip without producing an error.
    for (let i = 0; i < dueTriggers.length; i += MAX_CONCURRENT_TRIGGERS) {
      const batch = dueTriggers.slice(i, i + MAX_CONCURRENT_TRIGGERS);

      // Load associated calendar events for the batch
      const eventIds = [...new Set(batch.map(t => t.calendarEventId))];
      const events = await db
        .select()
        .from(calendarEvents)
        .where(inArray(calendarEvents.id, eventIds));

      const eventMap = new Map(events.map(e => [e.id, e]));

      const batchResults = await Promise.allSettled(
        batch.map(async (trigger) => {
          const event = eventMap.get(trigger.calendarEventId);
          if (!event || event.isTrashed) {
            // Record a cancelled run so the audit trail captures the skip,
            // and so the discovery query stops returning this trigger.
            await db.insert(workflowRuns).values({
              workflowId: trigger.workflowId,
              sourceTable: 'calendarTriggers',
              sourceId: trigger.id,
              triggerAt: trigger.triggerAt,
              status: 'cancelled',
              endedAt: new Date(),
              error: event ? 'Calendar event was trashed' : 'Calendar event not found',
            }).onConflictDoNothing();
            const cancelledResult: WorkflowExecutionResult = {
              success: false,
              durationMs: 0,
              error: 'Calendar event unavailable',
            };
            return { trigger, result: cancelledResult };
          }
          return { trigger, result: await executeCalendarTrigger(trigger, event) };
        })
      );

      for (let j = 0; j < batchResults.length; j++) {
        const settled = batchResults[j];
        if (settled.status === 'fulfilled') {
          totalAttempted++;
          if (settled.value.result.success) {
            executed++;
          } else if (!settled.value.result.claimConflict) {
            errors.push(`trigger-${settled.value.trigger.id}: ${settled.value.result.error}`);
          }
          if (settled.value.result.finalizeError) {
            errors.push(`trigger-${settled.value.trigger.id}: finalize failed: ${settled.value.result.finalizeError}`);
          }
        } else {
          totalAttempted++;
          const trigger = batch[j];
          const errorMsg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
          logger.error('Calendar trigger execution rejected', { triggerId: trigger.id, error: errorMsg });
          errors.push(`trigger-${trigger.id}: ${errorMsg}`);
        }
      }
    }

    logger.info(`Calendar trigger cron: Complete. Executed ${executed}/${totalAttempted}`);

    // 4. Look-ahead refill: recurring events whose future trigger queue is running
    //    dry get a fresh batch of occurrence rows. Uses the same pure expansion
    //    function as the upsert path — ON CONFLICT DO NOTHING makes it safe to
    //    call every tick without duplicates.
    await refillRecurringTriggers(now);

    audit({ eventType: 'data.write', resourceType: 'cron_job', resourceId: 'calendar_triggers', details: { executed, failed: errors.length } });

    return NextResponse.json({
      message: 'Calendar trigger cron complete',
      executed,
      total: totalAttempted,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    logger.error('Calendar trigger cron error:', error as Error);
    return NextResponse.json({ error: 'Calendar trigger cron failed' }, { status: 500 });
  }
}

async function refillRecurringTriggers(now: Date): Promise<void> {
  const lookaheadCutoff = new Date(now.getTime() + REFILL_LOOKAHEAD_DAYS * 86_400_000);

  // Find recurring events whose trigger queue has no rows beyond the lookahead
  // window — these need a fresh batch of future occurrence rows. Driving from
  // calendarEvents (not calendarTriggers) means events whose all trigger rows
  // were fired and none remain are still found correctly.
  const needsRefill = await db
    .selectDistinct({
      calendarEventId: calendarEvents.id,
      workflowId: calendarTriggers.workflowId,
      driveId: calendarTriggers.driveId,
      scheduledById: calendarTriggers.scheduledById,
    })
    .from(calendarEvents)
    .innerJoin(calendarTriggers, eq(calendarTriggers.calendarEventId, calendarEvents.id))
    .where(and(
      isNotNull(calendarEvents.recurrenceRule),
      eq(calendarEvents.isTrashed, false),
      sql`NOT EXISTS (
        SELECT 1 FROM ${calendarTriggers} ct2
        WHERE ct2."calendarEventId" = ${calendarEvents.id}
          AND ct2."triggerAt" > ${lookaheadCutoff}
      )`,
    ))
    .limit(REFILL_MAX_EVENTS);

  if (needsRefill.length === 0) return;

  const eventIds = needsRefill.map((r) => r.calendarEventId);
  const events = await db
    .select()
    .from(calendarEvents)
    .where(inArray(calendarEvents.id, eventIds));

  const eventMap = new Map(events.map((e) => [e.id, e]));
  const horizon = new Date(now.getTime() + REFILL_HORIZON_DAYS * 86_400_000);

  await Promise.allSettled(
    needsRefill.map(async (row) => {
      const event = eventMap.get(row.calendarEventId);
      if (!event?.recurrenceRule) return;

      const occurrences = expandOccurrences(
        event.recurrenceRule,
        event.startAt,
        now,
        horizon,
        event.recurrenceExceptions ?? [],
      );

      await bulkCreateOccurrenceTriggerRows(db, {
        workflowId: row.workflowId,
        calendarEventId: row.calendarEventId,
        driveId: row.driveId,
        scheduledById: row.scheduledById,
        occurrences,
      });
    }),
  );
}
