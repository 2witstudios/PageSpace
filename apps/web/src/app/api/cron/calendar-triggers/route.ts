import { NextResponse } from 'next/server';
import { db, calendarTriggers, calendarEvents, eq, and, lte, inArray, asc } from '@pagespace/db';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { executeCalendarTrigger } from '@/lib/workflows/calendar-trigger-executor';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { audit } from '@pagespace/lib/audit/audit-log';

const STUCK_TRIGGER_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CONCURRENT_TRIGGERS = 5;

const logger = loggers.api.child({ module: 'cron-calendar-triggers' });

export async function POST(req: Request) {
  const authError = validateSignedCronRequest(req);
  if (authError) return authError;

  try {
    const now = new Date();

    // 1. Reset stuck triggers (running > 10 min)
    const stuckCutoff = new Date(now.getTime() - STUCK_TRIGGER_TIMEOUT_MS);
    await db
      .update(calendarTriggers)
      .set({
        status: 'failed',
        error: 'Trigger timed out (stuck in running state)',
        completedAt: now,
      })
      .where(
        and(
          eq(calendarTriggers.status, 'running'),
          lte(calendarTriggers.startedAt, stuckCutoff)
        )
      );

    // 2. Find pending triggers that are due (bounded to prevent unbounded result sets)
    const MAX_DUE_TRIGGERS = 50;
    const dueTriggers = await db
      .select()
      .from(calendarTriggers)
      .where(
        and(
          eq(calendarTriggers.status, 'pending'),
          lte(calendarTriggers.triggerAt, now)
        )
      )
      .orderBy(asc(calendarTriggers.triggerAt))
      .limit(MAX_DUE_TRIGGERS);

    if (dueTriggers.length === 0) {
      audit({ eventType: 'data.write', resourceType: 'cron_job', resourceId: 'calendar_triggers', details: { executed: 0, failed: 0 } });
      return NextResponse.json({ message: 'No calendar triggers due', executed: 0 });
    }

    logger.info(`Calendar trigger cron: Found ${dueTriggers.length} due triggers`);

    let executed = 0;
    let totalClaimed = 0;
    const errors: string[] = [];

    // 3. Process in batches
    for (let i = 0; i < dueTriggers.length; i += MAX_CONCURRENT_TRIGGERS) {
      const batch = dueTriggers.slice(i, i + MAX_CONCURRENT_TRIGGERS);
      const batchIds = batch.map(t => t.id);

      // Atomically claim directly to 'running' (no intermediate 'claimed' state
      // that could strand triggers if the process crashes between claim and start)
      const claimed = await db
        .update(calendarTriggers)
        .set({ status: 'running', claimedAt: now, startedAt: now })
        .where(
          and(
            inArray(calendarTriggers.id, batchIds),
            eq(calendarTriggers.status, 'pending'),
            lte(calendarTriggers.triggerAt, now)
          )
        )
        .returning();

      if (claimed.length === 0) continue;
      totalClaimed += claimed.length;

      // Load associated calendar events
      const eventIds = [...new Set(claimed.map(t => t.calendarEventId))];
      const events = await db
        .select()
        .from(calendarEvents)
        .where(inArray(calendarEvents.id, eventIds));

      const eventMap = new Map(events.map(e => [e.id, e]));

      // Execute batch concurrently — skip triggers whose events are trashed
      const batchResults = await Promise.allSettled(
        claimed.map(async (trigger) => {
          const event = eventMap.get(trigger.calendarEventId);
          if (!event || event.isTrashed) {
            await db
              .update(calendarTriggers)
              .set({ status: 'cancelled', completedAt: new Date(), error: event ? 'Calendar event was trashed' : 'Calendar event not found' })
              .where(eq(calendarTriggers.id, trigger.id));
            return { trigger, result: { success: false, durationMs: 0, error: 'Calendar event unavailable' } as const };
          }
          return { trigger, result: await executeCalendarTrigger(trigger, event) };
        })
      );

      for (let j = 0; j < batchResults.length; j++) {
        const settled = batchResults[j];
        if (settled.status === 'fulfilled') {
          if (settled.value.result.success) {
            executed++;
          } else {
            errors.push(`trigger-${settled.value.trigger.id}: ${settled.value.result.error}`);
          }
        } else {
          const trigger = claimed[j];
          const errorMsg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
          logger.error('Calendar trigger execution rejected', { triggerId: trigger.id, error: errorMsg });
          errors.push(`trigger-${trigger.id}: ${errorMsg}`);

          await db
            .update(calendarTriggers)
            .set({
              status: 'failed',
              error: errorMsg,
              completedAt: new Date(),
            })
            .where(eq(calendarTriggers.id, trigger.id));
        }
      }
    }

    logger.info(`Calendar trigger cron: Complete. Executed ${executed}/${totalClaimed}`);

    audit({ eventType: 'data.write', resourceType: 'cron_job', resourceId: 'calendar_triggers', details: { executed, failed: errors.length } });

    return NextResponse.json({
      message: 'Calendar trigger cron complete',
      executed,
      total: totalClaimed,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    logger.error('Calendar trigger cron error:', error as Error);
    return NextResponse.json({ error: 'Calendar trigger cron failed' }, { status: 500 });
  }
}
