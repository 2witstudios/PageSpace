import { NextResponse } from 'next/server';
import { db, calendarTriggers, calendarEvents, eq, and, lte, inArray } from '@pagespace/db';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { executeCalendarTrigger } from '@/lib/workflows/calendar-trigger-executor';
import { loggers } from '@pagespace/lib/server';

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

    // 2. Find pending triggers that are due
    const dueTriggers = await db
      .select()
      .from(calendarTriggers)
      .where(
        and(
          eq(calendarTriggers.status, 'pending'),
          lte(calendarTriggers.triggerAt, now)
        )
      );

    if (dueTriggers.length === 0) {
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

      // Atomically claim this batch (UPDATE...RETURNING prevents double-execution)
      const claimed = await db
        .update(calendarTriggers)
        .set({ status: 'claimed', claimedAt: now })
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

      // Mark as running
      await db
        .update(calendarTriggers)
        .set({ status: 'running', startedAt: new Date() })
        .where(inArray(calendarTriggers.id, claimed.map(t => t.id)));

      // Load associated calendar events
      const eventIds = [...new Set(claimed.map(t => t.calendarEventId))];
      const events = await db
        .select()
        .from(calendarEvents)
        .where(inArray(calendarEvents.id, eventIds));

      const eventMap = new Map(events.map(e => [e.id, e]));

      // Execute batch concurrently
      const batchResults = await Promise.allSettled(
        claimed.map(async (trigger) => {
          const event = eventMap.get(trigger.calendarEventId);
          if (!event) {
            throw new Error(`Calendar event ${trigger.calendarEventId} not found`);
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
