import { db, calendarTriggers, pages, eventAttendees, users, eq, and } from '@pagespace/db';
import type { CalendarTrigger, CalendarEvent } from '@pagespace/db';
import { executeWorkflow, type WorkflowExecutionResult } from './workflow-executor';
import { incrementUsage } from '@/lib/subscription/usage-service';
import { isUserDriveMember } from '@pagespace/lib';
import { loggers } from '@pagespace/lib/server';

const logger = loggers.api.child({ module: 'calendar-trigger-executor' });

/**
 * Execute a calendar-triggered LLM agent invocation.
 *
 * Builds the prompt from the trigger's short instruction, optional instruction page,
 * and calendar event context, then delegates to the existing workflow executor.
 */
export async function executeCalendarTrigger(
  trigger: CalendarTrigger,
  event: CalendarEvent
): Promise<WorkflowExecutionResult> {
  const startTime = Date.now();

  try {
    // 1. Verify scheduling user still has drive access (may have been removed since scheduling)
    const hasDriveAccess = await isUserDriveMember(trigger.scheduledById, trigger.driveId);
    if (!hasDriveAccess) {
      const error = 'Scheduling user no longer has access to the drive';
      await markTriggerFailed(trigger.id, error, Date.now() - startTime);
      return { success: false, durationMs: Date.now() - startTime, error };
    }

    // 2. Cheap preflight: verify agent page still exists before consuming a usage credit
    const [agentPage] = await db
      .select({ id: pages.id, isTrashed: pages.isTrashed })
      .from(pages)
      .where(eq(pages.id, trigger.agentPageId));

    if (!agentPage || agentPage.isTrashed) {
      const error = `Trigger agent page ${trigger.agentPageId} not found or trashed`;
      await markTriggerFailed(trigger.id, error, Date.now() - startTime);
      return { success: false, durationMs: Date.now() - startTime, error };
    }

    // 3. Rate-limit check: consume one standard AI call from the scheduler's budget
    const usageResult = await incrementUsage(trigger.scheduledById, 'standard');
    if (!usageResult.success) {
      const error = 'Daily AI call limit reached for scheduling user';
      await markTriggerFailed(trigger.id, error, Date.now() - startTime);
      return { success: false, durationMs: Date.now() - startTime, error };
    }

    // 4. Build prompt from trigger instructions + instruction page + event context
    const prompt = await buildTriggerPrompt(trigger, event);

    // 5. Construct synthetic WorkflowRow that executeWorkflow can consume.
    //    We only populate the fields the executor actually reads.
    const syntheticWorkflow = {
      id: trigger.id,
      driveId: trigger.driveId,
      createdBy: trigger.scheduledById,
      name: `calendar-trigger-${trigger.id}`,
      agentPageId: trigger.agentPageId,
      prompt,
      contextPageIds: trigger.contextPageIds,
      cronExpression: null,
      timezone: event.timezone,
      triggerType: 'cron' as const,
      eventTriggers: null,
      watchedFolderIds: null,
      eventDebounceSecs: null,
      taskItemId: null,
      instructionPageId: null, // already loaded by buildTriggerPrompt — avoid double injection
      isEnabled: true,
      lastRunAt: null,
      nextRunAt: null,
      lastRunStatus: 'never_run' as const,
      lastRunError: null,
      lastRunDurationMs: null,
      createdAt: trigger.createdAt,
      updatedAt: trigger.updatedAt,
    };

    // 6. Execute via the standard workflow executor
    const result = await executeWorkflow(syntheticWorkflow);

    // 7. Update trigger with execution results
    await db
      .update(calendarTriggers)
      .set({
        status: result.success ? 'completed' : 'failed',
        completedAt: new Date(),
        error: result.error || null,
        durationMs: result.durationMs,
        conversationId: result.conversationId || null,
      })
      .where(eq(calendarTriggers.id, trigger.id));

    logger.info('Calendar trigger executed', {
      triggerId: trigger.id,
      agentPageId: trigger.agentPageId,
      success: result.success,
      durationMs: result.durationMs,
    });

    return result;

  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Calendar trigger execution failed', {
      triggerId: trigger.id,
      error: errorMessage,
      durationMs,
    });

    await markTriggerFailed(trigger.id, errorMessage, durationMs);
    return { success: false, durationMs, error: errorMessage };
  }
}

async function buildTriggerPrompt(trigger: CalendarTrigger, event: CalendarEvent): Promise<string> {
  const parts: string[] = [];

  // Event context
  parts.push('<scheduled-event>');
  parts.push(`Title: ${event.title}`);
  parts.push(`Scheduled for: ${event.startAt.toISOString()}`);
  if (event.description) parts.push(`Description: ${event.description}`);
  if (event.location) parts.push(`Location: ${event.location}`);

  // Attendees
  const attendees = await db
    .select({ name: users.name, email: users.email })
    .from(eventAttendees)
    .innerJoin(users, eq(eventAttendees.userId, users.id))
    .where(eq(eventAttendees.eventId, event.id));

  if (attendees.length > 0) {
    parts.push(`Attendees: ${attendees.map(a => a.name || a.email).join(', ')}`);
  }
  parts.push('</scheduled-event>');

  // Instruction page content (if linked) — verify access hasn't been revoked since scheduling
  if (trigger.instructionPageId) {
    const [instructionPage] = await db
      .select({ title: pages.title, content: pages.content, driveId: pages.driveId })
      .from(pages)
      .where(and(eq(pages.id, trigger.instructionPageId), eq(pages.isTrashed, false)));

    if (instructionPage?.content) {
      // Re-check access: scheduler must still have access to the instruction page's drive
      let hasAccess = true;
      if (instructionPage.driveId) {
        hasAccess = await isUserDriveMember(trigger.scheduledById, instructionPage.driveId);
      } else {
        hasAccess = false; // personal pages rejected at schedule time, guard here too
      }

      if (hasAccess) {
        parts.push('\n--- Detailed Instructions ---');
        parts.push(`## ${instructionPage.title}`);
        parts.push(instructionPage.content);
      }
    }
  }

  // Agent's short prompt instruction
  parts.push(`\n${trigger.prompt}`);

  return parts.join('\n');
}

async function markTriggerFailed(triggerId: string, error: string, durationMs: number): Promise<void> {
  try {
    await db
      .update(calendarTriggers)
      .set({
        status: 'failed',
        completedAt: new Date(),
        error,
        durationMs,
      })
      .where(eq(calendarTriggers.id, triggerId));
  } catch (updateError) {
    logger.error('Failed to mark trigger as failed', {
      triggerId,
      error: updateError instanceof Error ? updateError.message : String(updateError),
    });
  }
}
