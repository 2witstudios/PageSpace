import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { pages } from '@pagespace/db/schema/core'
import { eventAttendees } from '@pagespace/db/schema/calendar'
import { workflows } from '@pagespace/db/schema/workflows';
import type { CalendarEvent } from '@pagespace/db/schema/calendar'
import type { CalendarTrigger } from '@pagespace/db/schema/calendar-triggers';
import { executeWorkflow, type WorkflowExecutionResult, type WorkflowExecutionInput } from './workflow-executor';
import { incrementUsage } from '@/lib/subscription/usage-service';
import { isUserDriveMember } from '@pagespace/lib/permissions/permissions';
import { loggers } from '@pagespace/lib/logging/logger-config';

const logger = loggers.api.child({ module: 'calendar-trigger-executor' });

/**
 * Execute a calendar-triggered LLM agent invocation.
 *
 * Loads the linked workflows row by trigger.workflowId, composes a
 * WorkflowExecutionInput with the calendar event prompt as override,
 * and delegates to the workflow executor. Per-fire state (status,
 * timings, error, durationMs, conversationId) is written by the
 * executor to workflow_runs — calendar_triggers no longer carries any
 * per-fire columns.
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
      return { success: false, durationMs: Date.now() - startTime, error };
    }

    // 2. Load the linked workflows row (the trigger holds only "when"; payload lives on workflows)
    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, trigger.workflowId));

    if (!workflow) {
      const error = `Linked workflow ${trigger.workflowId} not found`;
      return { success: false, durationMs: Date.now() - startTime, error };
    }

    // 3. Cheap preflight: verify agent page still exists before consuming a usage credit
    const [agentPage] = await db
      .select({ id: pages.id, isTrashed: pages.isTrashed })
      .from(pages)
      .where(eq(pages.id, workflow.agentPageId));

    if (!agentPage || agentPage.isTrashed) {
      const error = `Trigger agent page ${workflow.agentPageId} not found or trashed`;
      return { success: false, durationMs: Date.now() - startTime, error };
    }

    // 4. Rate-limit check: consume one standard AI call from the scheduler's budget
    const usageResult = await incrementUsage(trigger.scheduledById, 'standard');
    if (!usageResult.success) {
      const error = 'Daily AI call limit reached for scheduling user';
      return { success: false, durationMs: Date.now() - startTime, error };
    }

    // 5. Build the prompt from the workflow's stored prompt + event context.
    //    The instruction page is loaded by executeWorkflow (input.instructionPageId),
    //    so we don't double-inject it here.
    const promptOverride = await buildTriggerPrompt(workflow.prompt, event);

    // 6. Compose execution input — the executor writes workflow_runs and
    //    handles per-fire bookkeeping; we just pass the source coordinates.
    const input: WorkflowExecutionInput = {
      workflowId: workflow.id,
      workflowName: `calendar-trigger-${trigger.id}`,
      driveId: workflow.driveId,
      createdBy: trigger.scheduledById,
      agentPageId: workflow.agentPageId,
      prompt: workflow.prompt,
      contextPageIds: (workflow.contextPageIds as string[] | null) ?? [],
      instructionPageId: workflow.instructionPageId,
      timezone: event.timezone,
      source: { table: 'calendarTriggers', id: trigger.id, triggerAt: trigger.triggerAt },
      eventContext: { promptOverride },
    };

    const result = await executeWorkflow(input);

    logger.info('Calendar trigger executed', {
      triggerId: trigger.id,
      workflowId: workflow.id,
      agentPageId: workflow.agentPageId,
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

    return { success: false, durationMs, error: errorMessage };
  }
}

async function buildTriggerPrompt(workflowPrompt: string, event: CalendarEvent): Promise<string> {
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

  // The workflow's stored prompt becomes the instruction line at the end
  parts.push(`\n${workflowPrompt}`);

  return parts.join('\n');
}
