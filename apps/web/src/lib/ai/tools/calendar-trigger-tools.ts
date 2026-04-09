import { tool } from 'ai';
import { z } from 'zod';
import {
  db,
  calendarEvents,
  calendarTriggers,
  pages,
  eq,
} from '@pagespace/db';
import type { CalendarTriggerMetadata } from '@pagespace/db';
import { isUserDriveMember } from '@pagespace/lib';
import { loggers } from '@pagespace/lib/server';
import { broadcastCalendarEvent } from '@/lib/websocket/calendar-events';
import { type ToolExecutionContext } from '../core';
import { normalizeTimezone, formatDateInTimezone, parseDateTime } from '../core/timestamp-utils';
import { maskIdentifier } from '@/lib/logging/mask';

const triggerLogger = loggers.ai.child({ module: 'calendar-trigger-tools' });

export const calendarTriggerTools = {
  /**
   * Schedule future AI agent work as a calendar event
   */
  schedule_agent_work: tool({
    description:
      'Schedule future AI agent work by creating a calendar event that triggers agent execution at the specified time. Use this to schedule tasks like "check deploy status at 3pm" or "summarize activity next Monday morning". The target agent runs with the given prompt and context when the scheduled time arrives.',
    inputSchema: z.object({
      title: z.string().min(1).max(500).describe('Title for the scheduled work (appears on calendar)'),
      triggerAt: z.string().describe('When to execute. ISO 8601 or natural language (e.g., "tomorrow at 9am", "next Monday 2pm", "in 2 hours")'),
      agentPageId: z.string().describe('ID of the AI agent page to execute. Use list_agents to find available agents.'),
      driveId: z.string().describe('Drive ID where the agent lives and work will happen'),
      prompt: z.string().max(10000).optional().describe('Instructions for the agent when it runs. Keep concise for simple tasks.'),
      instructionPageId: z.string().optional().describe('Page ID containing detailed instructions (for complex tasks). The agent reads this page at execution time.'),
      contextPageIds: z.array(z.string()).max(10).optional().describe('Page IDs to include as reference context for the agent'),
      timezone: z.string().optional().describe('Timezone for interpreting triggerAt (defaults to your timezone)'),
    }),
    execute: async (
      { title, triggerAt, agentPageId, driveId, prompt, instructionPageId, contextPageIds, timezone: timezoneInput },
      { experimental_context: ctx }
    ) => {
      const userId = (ctx as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      const userTimezone = (ctx as ToolExecutionContext)?.timezone;
      const timezone = normalizeTimezone(timezoneInput ?? userTimezone);

      try {
        // Validate: need at least a prompt or instruction page
        if (!prompt && !instructionPageId) {
          return {
            success: false,
            error: 'Provide either a prompt or instructionPageId (or both) so the agent knows what to do.',
          };
        }

        // Validate drive access
        const canAccess = await isUserDriveMember(userId, driveId);
        if (!canAccess) {
          return { success: false, error: 'You do not have access to this drive.' };
        }

        // Validate agent exists, is AI_CHAT, and belongs to an accessible drive
        const [agent] = await db
          .select({ id: pages.id, type: pages.type, title: pages.title, isTrashed: pages.isTrashed, driveId: pages.driveId })
          .from(pages)
          .where(eq(pages.id, agentPageId));

        if (!agent) {
          return { success: false, error: 'Agent page not found. Use list_agents to find available agents.' };
        }
        if (agent.type !== 'AI_CHAT') {
          return { success: false, error: `Page "${agent.title}" is not an AI agent (type: ${agent.type}). Only AI_CHAT pages can be scheduled.` };
        }
        if (agent.isTrashed) {
          return { success: false, error: `Agent "${agent.title}" is in trash.` };
        }
        // Enforce that the agent belongs to a drive the caller can access
        if (agent.driveId) {
          const canAccessAgentDrive = agent.driveId === driveId || await isUserDriveMember(userId, agent.driveId);
          if (!canAccessAgentDrive) {
            return { success: false, error: 'You do not have access to the drive containing this agent.' };
          }
        }

        // Validate instruction page if provided — must exist and be in an accessible drive
        if (instructionPageId) {
          const [instrPage] = await db
            .select({ id: pages.id, isTrashed: pages.isTrashed, driveId: pages.driveId })
            .from(pages)
            .where(eq(pages.id, instructionPageId));

          if (!instrPage) {
            return { success: false, error: 'Instruction page not found.' };
          }
          if (instrPage.isTrashed) {
            return { success: false, error: 'Instruction page is in trash.' };
          }
          if (instrPage.driveId) {
            const canAccessInstrDrive = instrPage.driveId === driveId || await isUserDriveMember(userId, instrPage.driveId);
            if (!canAccessInstrDrive) {
              return { success: false, error: 'You do not have access to the drive containing the instruction page.' };
            }
          }
        }

        // Parse trigger time
        const parsedTriggerAt = parseDateTime(triggerAt, undefined, timezone);

        // Must be in the future
        if (parsedTriggerAt <= new Date()) {
          return {
            success: false,
            error: 'Trigger time must be in the future.',
          };
        }

        // Create calendar event + trigger row + backfill metadata atomically
        const triggerPrompt = prompt || `Execute instructions from linked page.`;
        const scheduledByAgentPageId = (ctx as ToolExecutionContext)?.chatSource?.agentPageId;

        const { event, trigger } = await db.transaction(async (tx) => {
          const [evt] = await tx
            .insert(calendarEvents)
            .values({
              driveId,
              createdById: userId,
              title,
              description: `Scheduled agent work: ${agent.title}`,
              startAt: parsedTriggerAt,
              endAt: new Date(parsedTriggerAt.getTime() + 15 * 60 * 1000), // 15-min default duration
              timezone,
              color: 'focus',
              visibility: 'DRIVE',
              metadata: {
                isTrigger: true,
                triggerType: 'agent_execution',
                triggerId: '',
                scheduledByAgentPageId,
              } satisfies CalendarTriggerMetadata,
              updatedAt: new Date(),
            })
            .returning();

          const [trg] = await tx
            .insert(calendarTriggers)
            .values({
              calendarEventId: evt.id,
              agentPageId,
              driveId,
              scheduledById: userId,
              prompt: triggerPrompt,
              instructionPageId: instructionPageId ?? null,
              contextPageIds: contextPageIds ?? [],
              status: 'pending',
              triggerAt: parsedTriggerAt,
            })
            .returning();

          // Backfill triggerId in calendar event metadata
          await tx
            .update(calendarEvents)
            .set({
              metadata: {
                isTrigger: true,
                triggerType: 'agent_execution',
                triggerId: trg.id,
                scheduledByAgentPageId,
              } satisfies CalendarTriggerMetadata,
            })
            .where(eq(calendarEvents.id, evt.id));

          return { event: evt, trigger: trg };
        });

        // Broadcast calendar event creation
        await broadcastCalendarEvent({
          eventId: event.id,
          driveId,
          operation: 'created',
          userId,
          attendeeIds: [userId],
        });

        triggerLogger.info('Scheduled agent work created', {
          triggerId: maskIdentifier(trigger.id),
          eventId: maskIdentifier(event.id),
          agentPageId: maskIdentifier(agentPageId),
          userId: maskIdentifier(userId),
          triggerAt: parsedTriggerAt.toISOString(),
        });

        return {
          success: true,
          data: {
            triggerId: trigger.id,
            eventId: event.id,
            scheduledFor: parsedTriggerAt.toISOString(),
            agentName: agent.title,
          },
          summary: `Scheduled "${title}" for ${formatDateInTimezone(parsedTriggerAt, timezone)} — agent "${agent.title}" will execute with your instructions.`,
          nextSteps: [
            'Use list_calendar_events to see scheduled work on the calendar',
            'Use cancel_scheduled_work to cancel if no longer needed',
          ],
        };
      } catch (error) {
        triggerLogger.error('Failed to schedule agent work', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          title,
        });
        throw new Error(
          `Failed to schedule agent work: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  }),

  /**
   * Cancel scheduled agent work
   */
  cancel_scheduled_work: tool({
    description:
      'Cancel a previously scheduled agent work trigger. Cannot cancel work that is already running.',
    inputSchema: z.object({
      triggerId: z.string().describe('The trigger ID returned by schedule_agent_work'),
    }),
    execute: async ({ triggerId }, { experimental_context: ctx }) => {
      const userId = (ctx as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Load trigger
        const [trigger] = await db
          .select()
          .from(calendarTriggers)
          .where(eq(calendarTriggers.id, triggerId));

        if (!trigger) {
          return { success: false, error: 'Scheduled work not found.' };
        }

        // Only the user who scheduled the work can cancel it
        if (trigger.scheduledById !== userId) {
          return { success: false, error: 'Only the user who scheduled this work can cancel it.' };
        }

        // Check current status
        if (trigger.status === 'running') {
          return { success: false, error: 'Cannot cancel work that is already running.' };
        }
        if (trigger.status === 'completed' || trigger.status === 'failed' || trigger.status === 'cancelled') {
          return {
            success: true,
            data: { triggerId, status: trigger.status },
            summary: `This scheduled work already has status: ${trigger.status}. No action needed.`,
          };
        }

        // Cancel the trigger
        await db
          .update(calendarTriggers)
          .set({ status: 'cancelled', completedAt: new Date() })
          .where(eq(calendarTriggers.id, triggerId));

        // Soft-delete the calendar event
        await db
          .update(calendarEvents)
          .set({ isTrashed: true, trashedAt: new Date(), updatedAt: new Date() })
          .where(eq(calendarEvents.id, trigger.calendarEventId));

        // Broadcast deletion
        await broadcastCalendarEvent({
          eventId: trigger.calendarEventId,
          driveId: trigger.driveId,
          operation: 'deleted',
          userId,
          attendeeIds: [userId],
        });

        triggerLogger.info('Scheduled agent work cancelled', {
          triggerId: maskIdentifier(triggerId),
          userId: maskIdentifier(userId),
        });

        return {
          success: true,
          data: { triggerId, status: 'cancelled' },
          summary: 'Scheduled work has been cancelled and removed from the calendar.',
        };
      } catch (error) {
        triggerLogger.error('Failed to cancel scheduled work', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          triggerId: maskIdentifier(triggerId),
        });
        throw new Error(
          `Failed to cancel scheduled work: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  }),
};
