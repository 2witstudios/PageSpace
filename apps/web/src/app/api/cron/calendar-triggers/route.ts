import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq, and, lte, inArray, asc, sql } from '@pagespace/db/operators'
import { calendarEvents } from '@pagespace/db/schema/calendar'
import { calendarTriggers } from '@pagespace/db/schema/calendar-triggers';
import { workflowRuns } from '@pagespace/db/schema/workflow-runs';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { executeCalendarTrigger } from '@/lib/workflows/calendar-trigger-executor';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { audit } from '@pagespace/lib/audit/audit-log';

const STUCK_RUN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CONCURRENT_TRIGGERS = 5;
const MAX_DUE_TRIGGERS = 50;

const logger = loggers.api.child({ module: 'cron-calendar-triggers' });

/**
 * POST /api/cron/calendar-triggers — fire due calendar triggers (one-shot).
 *
 * Discovery: calendar_triggers rows where triggerAt <= NOW() AND no
 * workflow_runs row exists with sourceTable='calendarTriggers',
 * sourceId=trigger.id, status IN ('running','success'). Per-fire state
 * (status, timings, error, durationMs, conversationId) lives on
 * workflow_runs — calendar_triggers no longer carries any per-fire
 * columns. Atomic claim is the workflow_runs partial unique index
 * inside the executor, not state on the trigger row.
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
    //    row already running or successful for them. The NOT EXISTS subquery uses
    //    the (sourceTable, sourceId, status) index for a fast lookup.
    const dueTriggers = await db
      .select()
      .from(calendarTriggers)
      .where(and(
        lte(calendarTriggers.triggerAt, now),
        sql`NOT EXISTS (
          SELECT 1 FROM ${workflowRuns}
          WHERE ${workflowRuns.sourceTable} = 'calendarTriggers'
            AND ${workflowRuns.sourceId} = ${calendarTriggers.id}
            AND ${workflowRuns.status} IN ('running', 'success')
        )`,
      ))
      .orderBy(asc(calendarTriggers.triggerAt))
      .limit(MAX_DUE_TRIGGERS);

    if (dueTriggers.length === 0) {
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
            return { trigger, result: { success: false, durationMs: 0, error: 'Calendar event unavailable' } as const };
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
