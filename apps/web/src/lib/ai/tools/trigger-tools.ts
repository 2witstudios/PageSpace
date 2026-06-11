import { tool } from 'ai';
import { z } from 'zod';
import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { calendarEvents, eventAttendees } from '@pagespace/db/schema/calendar';
import { taskItems, taskLists } from '@pagespace/db/schema/tasks';
import { taskTriggers } from '@pagespace/db/schema/task-triggers';
import { agentTriggerBaseSchema } from '@/lib/workflows/agent-trigger-shared';
import {
  upsertCalendarTriggerWorkflow,
  upsertCalendarTriggerWorkflowInTx,
  removeCalendarTrigger,
  validateCalendarAgentTrigger,
} from '@/lib/workflows/calendar-trigger-helpers';
import {
  createTaskTriggerWorkflow,
  recomputeTaskTriggerMetadata,
} from '@/lib/workflows/task-trigger-helpers';
import { isUserDriveMember, canUserEditPage } from '@pagespace/lib/permissions/permissions';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { broadcastCalendarEvent } from '@/lib/websocket/calendar-events';
import { broadcastTaskEvent } from '@/lib/websocket';
import type { ToolExecutionContext } from '../core/types';
import { canActorManageDrive, driveDeniedByAppToken } from './actor-permissions';
import { parseDateTime, normalizeTimezone } from '../core/timestamp-utils';
import type { CalendarTriggerMetadata } from '@pagespace/db/schema/calendar-triggers';

const logger = loggers.ai.child({ module: 'trigger-tools' });

async function loadEventAttendeeIds(eventId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: eventAttendees.userId })
    .from(eventAttendees)
    .where(eq(eventAttendees.eventId, eventId));
  return rows.map((r) => r.userId);
}

async function canManageEvent(
  ctx: ToolExecutionContext,
  userId: string,
  event: typeof calendarEvents.$inferSelect,
): Promise<boolean> {
  if (event.createdById === userId) return true;
  if (event.driveId) return canActorManageDrive(ctx, event.driveId);
  return false;
}

/**
 * Dedicated tools for attaching and removing agent triggers on calendar events
 * and task items.
 *
 * These are the primary surface for trigger management. The agentTrigger
 * parameters that exist on create_calendar_event / update_calendar_event /
 * create_task / update_task remain as convenience shortcuts but agents should
 * prefer these tools when working with existing entities or scheduling new
 * agent runs, because the intent is explicit and the schema is flat (no nested
 * agentTrigger wrapper to navigate).
 */
export const triggerTools = {
  set_calendar_trigger: tool({
    description: `Attach or update an agent trigger on a calendar event — the agent runs when the event time arrives.

Works in two modes:
- **Attach to an existing event**: provide calendarEventId. The trigger is set on the event as-is; you must be the event creator or a drive owner/admin.
- **Create a new scheduling event**: provide triggerAt (ISO 8601 datetime), driveId, and timezone. A calendar event is created solely as the scheduling anchor, and the agent trigger is set on it. Use this when there is no existing event to attach to.

Either way, returns the calendarEventId so you can pass it to delete_calendar_trigger later. Calling again on the same calendarEventId replaces the existing trigger (upsert).`,
    inputSchema: z.object({
      calendarEventId: z.string().optional().describe('Existing calendar event ID to attach the trigger to. Provide this OR (triggerAt + driveId).'),
      triggerAt: z.string().optional().describe('ISO 8601 datetime for the new scheduling event, e.g. "2025-06-15T09:00:00". Provide this with driveId when there is no existing event.'),
      driveId: z.string().optional().describe('Drive the new scheduling event belongs to. Required when using triggerAt.'),
      timezone: z.string().optional().describe('IANA timezone for interpreting triggerAt (e.g. "America/New_York"). Defaults to the user\'s timezone, then UTC.'),
      name: z.string().max(200).optional().describe('Name for the new scheduling event (only used when triggerAt is provided). Defaults to "Agent trigger".'),
      agentPageId: z.string().describe('ID of the AI agent (AI_CHAT page) to execute when the trigger fires.'),
      prompt: z.string().max(10000).optional().describe('Instructions passed to the agent when it runs. Required if instructionPageId is omitted.'),
      instructionPageId: z.string().nullable().optional().describe('ID of a page containing the agent\'s instructions. Required if prompt is omitted.'),
      contextPageIds: z.array(z.string()).max(10).optional().describe('Up to 10 page IDs to include as reference context for the agent.'),
    }),
    execute: async (params, { experimental_context: context }) => {
      const ctx = context as ToolExecutionContext;
      const userId = ctx?.userId;
      if (!userId) throw new Error('User authentication required');

      const { calendarEventId, triggerAt, driveId, timezone: tzInput, name, agentPageId, prompt, instructionPageId, contextPageIds } = params;

      const agentTrigger = { agentPageId, prompt, instructionPageId, contextPageIds };

      if (!prompt && !instructionPageId) {
        return { success: false, error: 'Provide either a prompt or instructionPageId for the agent trigger.' };
      }

      // --- Attach to existing event ---
      if (calendarEventId) {
        const event = await db.query.calendarEvents.findFirst({
          where: and(eq(calendarEvents.id, calendarEventId), eq(calendarEvents.isTrashed, false)),
        });
        if (!event) return { success: false, error: 'Calendar event not found.' };

        if (!event.driveId) {
          return { success: false, error: 'Agent triggers require a drive event. This event has no drive.' };
        }

        if (await driveDeniedByAppToken(ctx, event.driveId, 'edit')) {
          return { success: false, error: 'This token does not have access to this event\'s drive.' };
        }

        if (!(await canManageEvent(ctx, userId, event))) {
          return { success: false, error: 'You must be the event creator or a drive admin to manage triggers on this event.' };
        }

        try {
          await upsertCalendarTriggerWorkflow(db, {
            driveId: event.driveId,
            scheduledById: userId,
            calendarEventId,
            triggerAt: event.startAt,
            timezone: event.timezone ?? 'UTC',
            agentTrigger,
            recurrenceRule: event.recurrenceRule,
            recurrenceExceptions: event.recurrenceExceptions ?? [],
          });
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'Failed to save trigger' };
        }

        const attendeeIds = await loadEventAttendeeIds(calendarEventId);
        void broadcastCalendarEvent({ eventId: calendarEventId, driveId: event.driveId, operation: 'updated', userId, attendeeIds });

        logger.info('Calendar trigger set on existing event', { calendarEventId, agentPageId });
        return { success: true, calendarEventId, summary: `Agent trigger set on event "${event.title}". The agent will run at ${event.startAt.toISOString()}.` };
      }

      // --- Create new scheduling event ---
      if (!triggerAt || !driveId) {
        return { success: false, error: 'Provide either calendarEventId (to attach to an existing event) or both triggerAt and driveId (to create a new scheduling event).' };
      }

      if (await driveDeniedByAppToken(ctx, driveId, 'edit')) {
        return { success: false, error: 'This token does not have access to the specified drive.' };
      }
      if (!(await isUserDriveMember(userId, driveId))) {
        return { success: false, error: 'You do not have access to this drive.' };
      }

      const tz = normalizeTimezone(tzInput ?? ctx.timezone);
      const parsedAt = parseDateTime(triggerAt, undefined, tz);
      const endAt = new Date(parsedAt.getTime() + 60 * 60 * 1000);

      try {
        await validateCalendarAgentTrigger(db, { driveId, agentTrigger });
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Invalid agent trigger' };
      }

      const scheduledByAgentPageId = ctx?.chatSource?.agentPageId;

      const { eventId: createdEventId } = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(calendarEvents)
          .values({
            driveId,
            createdById: userId,
            title: name ?? 'Agent trigger',
            startAt: parsedAt,
            endAt,
            allDay: false,
            timezone: tz,
            visibility: 'DRIVE',
            color: 'default',
            updatedAt: new Date(),
          })
          .returning({ id: calendarEvents.id });

        await tx.insert(eventAttendees).values({ eventId: created.id, userId, status: 'ACCEPTED', isOrganizer: true, respondedAt: new Date() });

        const { triggerId } = await upsertCalendarTriggerWorkflowInTx(tx, {
          driveId,
          scheduledById: userId,
          calendarEventId: created.id,
          triggerAt: parsedAt,
          timezone: tz,
          agentTrigger,
          recurrenceRule: null,
          recurrenceExceptions: [],
        });

        await tx.update(calendarEvents).set({
          metadata: {
            isTrigger: true,
            triggerType: 'agent_execution',
            triggerId,
            scheduledByAgentPageId,
          } satisfies CalendarTriggerMetadata,
        }).where(eq(calendarEvents.id, created.id));

        return { eventId: created.id };
      });

      void broadcastCalendarEvent({ eventId: createdEventId, driveId, operation: 'created', userId, attendeeIds: [userId] });

      logger.info('Calendar trigger created with new event', { calendarEventId: createdEventId, agentPageId, triggerAt: parsedAt.toISOString() });
      return { success: true, calendarEventId: createdEventId, summary: `Agent trigger scheduled at ${parsedAt.toISOString()} (${tz}). The agent will run at that time.` };
    },
  }),

  delete_calendar_trigger: tool({
    description: 'Remove the agent trigger from a calendar event. Does not delete the event itself — only the scheduled agent execution is cancelled. Idempotent: safe to call even if no trigger exists.',
    inputSchema: z.object({
      calendarEventId: z.string().describe('ID of the calendar event whose agent trigger should be removed.'),
    }),
    execute: async ({ calendarEventId }, { experimental_context: context }) => {
      const ctx = context as ToolExecutionContext;
      const userId = ctx?.userId;
      if (!userId) throw new Error('User authentication required');

      const event = await db.query.calendarEvents.findFirst({
        where: and(eq(calendarEvents.id, calendarEventId), eq(calendarEvents.isTrashed, false)),
      });
      if (!event) return { success: false, error: 'Calendar event not found.' };

      if (event.driveId && await driveDeniedByAppToken(ctx, event.driveId, 'edit')) {
        return { success: false, error: 'This token does not have access to this event\'s drive.' };
      }

      if (!(await canManageEvent(ctx, userId, event))) {
        return { success: false, error: 'You must be the event creator or a drive admin to manage triggers on this event.' };
      }

      await removeCalendarTrigger(db, calendarEventId);

      const attendeeIds = await loadEventAttendeeIds(calendarEventId);
      void broadcastCalendarEvent({ eventId: calendarEventId, driveId: event.driveId, operation: 'updated', userId, attendeeIds });

      logger.info('Calendar trigger removed', { calendarEventId });
      return { success: true, calendarEventId, summary: `Agent trigger removed from event "${event.title}".` };
    },
  }),

  set_task_trigger: tool({
    description: `Attach or update an agent trigger on an existing task item.

- triggerType 'due_date': the agent runs when the task's due date arrives. The task must already have a due date set.
- triggerType 'completion': the agent runs when the task is marked done.

Calling again with the same taskId + triggerType replaces the existing trigger (upsert). The task must belong to a drive-based task list.`,
    inputSchema: z.object({
      taskId: z.string().describe('ID of the task item to attach the trigger to.'),
      triggerType: z.enum(['due_date', 'completion']).describe('When the agent fires: at the task\'s due date, or when it is marked complete.'),
      agentPageId: z.string().describe('ID of the AI agent (AI_CHAT page) to execute.'),
      prompt: z.string().max(10000).optional().describe('Instructions passed to the agent. Required if instructionPageId is omitted.'),
      instructionPageId: z.string().nullable().optional().describe('ID of a page containing the agent\'s instructions. Required if prompt is omitted.'),
      contextPageIds: z.array(z.string()).max(10).optional().describe('Up to 10 page IDs to include as reference context for the agent.'),
    }),
    execute: async ({ taskId, triggerType, agentPageId, prompt, instructionPageId, contextPageIds }, { experimental_context: context }) => {
      const ctx = context as ToolExecutionContext;
      const userId = ctx?.userId;
      if (!userId) throw new Error('User authentication required');

      if (!prompt && !instructionPageId) {
        return { success: false, error: 'Provide either a prompt or instructionPageId for the agent trigger.' };
      }

      const task = await db.query.taskItems.findFirst({
        where: eq(taskItems.id, taskId),
        with: { page: { columns: { parentId: true } } },
      });
      if (!task?.page?.parentId) return { success: false, error: 'Task not found.' };

      const taskListPageId = task.page.parentId;
      const [taskListPage, taskList] = await Promise.all([
        db.query.pages.findFirst({
          where: eq(pages.id, taskListPageId),
          columns: { id: true, driveId: true, isTrashed: true },
        }),
        db.query.taskLists.findFirst({
          where: eq(taskLists.pageId, taskListPageId),
          columns: { id: true },
        }),
      ]);

      if (!taskListPage || taskListPage.isTrashed) return { success: false, error: 'Task list not found.' };
      if (!taskListPage.driveId) return { success: false, error: 'Task triggers require a drive-based task list.' };

      if (!(await canUserEditPage(userId, taskListPageId))) {
        return { success: false, error: 'You do not have edit access to this task list.' };
      }

      if (triggerType === 'due_date' && !task.dueDate) {
        return { success: false, error: 'The task must have a due date set before a due_date trigger can be attached. Set the task\'s due date first via update_task.' };
      }

      try {
        await createTaskTriggerWorkflow({
          database: db,
          driveId: taskListPage.driveId,
          userId,
          taskId,
          taskMetadata: task.metadata as Record<string, unknown> | null,
          agentTrigger: { agentPageId, prompt, instructionPageId: instructionPageId ?? undefined, contextPageIds: contextPageIds ?? [], triggerType },
          dueDate: task.dueDate,
          timezone: ctx.timezone ?? 'UTC',
        });
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to save trigger' };
      }

      void broadcastTaskEvent({ type: 'task_updated', taskId, taskListId: taskList?.id, userId, pageId: taskListPageId, data: { id: taskId, triggerType } });

      logger.info('Task trigger set', { taskId, triggerType, agentPageId });
      return {
        success: true,
        taskId,
        triggerType,
        summary: triggerType === 'due_date'
          ? `Agent trigger set on task. The agent will run at the task's due date (${task.dueDate!.toISOString()}).`
          : 'Agent trigger set on task. The agent will run when the task is marked complete.',
      };
    },
  }),

  delete_task_trigger: tool({
    description: 'Remove an agent trigger from a task. Disables the trigger so it will not fire. Idempotent: safe to call even if the trigger does not exist.',
    inputSchema: z.object({
      taskId: z.string().describe('ID of the task item.'),
      triggerType: z.enum(['due_date', 'completion']).describe('Which trigger to remove.'),
    }),
    execute: async ({ taskId, triggerType }, { experimental_context: context }) => {
      const ctx = context as ToolExecutionContext;
      const userId = ctx?.userId;
      if (!userId) throw new Error('User authentication required');

      const task = await db.query.taskItems.findFirst({
        where: eq(taskItems.id, taskId),
        with: { page: { columns: { parentId: true } } },
      });
      if (!task?.page?.parentId) return { success: false, error: 'Task not found.' };

      const taskListPageId = task.page.parentId;
      const [taskListPage, taskList] = await Promise.all([
        db.query.pages.findFirst({
          where: eq(pages.id, taskListPageId),
          columns: { id: true, isTrashed: true },
        }),
        db.query.taskLists.findFirst({
          where: eq(taskLists.pageId, taskListPageId),
          columns: { id: true },
        }),
      ]);

      if (!taskListPage || taskListPage.isTrashed) return { success: false, error: 'Task list not found.' };
      if (!(await canUserEditPage(userId, taskListPageId))) {
        return { success: false, error: 'You do not have edit access to this task list.' };
      }

      await db
        .update(taskTriggers)
        .set({ isEnabled: false, lastFireError: 'Disabled by agent', nextRunAt: null })
        .where(and(eq(taskTriggers.taskItemId, taskId), eq(taskTriggers.triggerType, triggerType)));

      await recomputeTaskTriggerMetadata(db, taskId, task.metadata as Record<string, unknown> | null);

      void broadcastTaskEvent({ type: 'task_updated', taskId, taskListId: taskList?.id, userId, pageId: taskListPageId, data: { id: taskId, removedTriggerType: triggerType } });

      logger.info('Task trigger removed', { taskId, triggerType });
      return { success: true, taskId, triggerType, summary: `${triggerType === 'due_date' ? 'Due-date' : 'Completion'} trigger removed from task.` };
    },
  }),
};
