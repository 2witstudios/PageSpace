import { tool } from 'ai';
import { z } from 'zod';
import * as chrono from 'chrono-node';
import {
  db,
  calendarEvents,
  eventAttendees,
  eq,
  and,
} from '@pagespace/db';
import { isUserDriveMember } from '@pagespace/lib';
import { getDriveMemberUserIds, loggers } from '@pagespace/lib/server';
import { broadcastCalendarEvent } from '@/lib/websocket/calendar-events';
import { type ToolExecutionContext } from '../core';
import { maskIdentifier } from '@/lib/logging/mask';

const calendarWriteLogger = loggers.ai.child({ module: 'calendar-write-tools' });

/**
 * Parse a date string that can be either ISO 8601 or natural language
 * Uses chrono-node for natural language parsing
 */
function parseDateTime(input: string, referenceDate?: Date): Date {
  // Try ISO 8601 first
  const isoDate = new Date(input);
  if (!isNaN(isoDate.getTime())) {
    return isoDate;
  }

  // Try natural language parsing with chrono-node
  const parsed = chrono.parseDate(input, referenceDate ?? new Date(), { forwardDate: true });
  if (!parsed) {
    throw new Error(`Could not parse date: "${input}". Use ISO 8601 format (e.g., "2024-01-15T10:00:00Z") or natural language (e.g., "tomorrow at 3pm", "next Monday 10am").`);
  }

  return parsed;
}

/**
 * Check if user can edit an event (only creator)
 */
async function canEditEvent(
  userId: string,
  event: typeof calendarEvents.$inferSelect
): Promise<boolean> {
  return event.createdById === userId;
}

/**
 * Get all attendee user IDs for an event
 */
async function getEventAttendeeIds(eventId: string): Promise<string[]> {
  const attendees = await db
    .select({ userId: eventAttendees.userId })
    .from(eventAttendees)
    .where(eq(eventAttendees.eventId, eventId));
  return attendees.map((a) => a.userId);
}

// Recurrence rule schema
const recurrenceRuleSchema = z
  .object({
    frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
    interval: z.number().int().min(1).default(1),
    byDay: z.array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])).optional(),
    byMonthDay: z.array(z.number().int().min(1).max(31)).optional(),
    byMonth: z.array(z.number().int().min(1).max(12)).optional(),
    count: z.number().int().min(1).optional(),
    until: z.string().optional(),
  })
  .nullable()
  .optional();

export const calendarWriteTools = {
  /**
   * Create a new calendar event
   */
  create_calendar_event: tool({
    description:
      'Create a new calendar event. Supports natural language dates like "tomorrow at 3pm" or "next Monday 10am" as well as ISO 8601 format. For recurring events, specify the recurrence rule.',
    inputSchema: z.object({
      title: z.string().min(1).max(500).describe('Event title'),
      startAt: z
        .string()
        .describe('Start date/time. Accepts ISO 8601 (e.g., "2024-01-15T10:00:00Z") or natural language (e.g., "tomorrow at 3pm", "next Monday 10am")'),
      endAt: z
        .string()
        .describe('End date/time. Accepts ISO 8601 or natural language. If not specified relative to start, defaults to 1 hour after start.'),
      driveId: z
        .string()
        .nullable()
        .optional()
        .describe('Drive ID for drive events. Omit or null for personal calendar events.'),
      description: z.string().max(10000).nullable().optional().describe('Event description'),
      location: z.string().max(1000).nullable().optional().describe('Event location'),
      allDay: z.boolean().optional().describe('Whether this is an all-day event (default: false)'),
      timezone: z.string().optional().describe('Timezone for the event (default: UTC, e.g., "America/New_York")'),
      recurrence: recurrenceRuleSchema.describe('Recurrence rule for repeating events'),
      visibility: z
        .enum(['DRIVE', 'ATTENDEES_ONLY', 'PRIVATE'])
        .optional()
        .describe('Event visibility: DRIVE (default, all drive members), ATTENDEES_ONLY (invited users only), PRIVATE (only you)'),
      color: z.string().optional().describe('Color category (default, meeting, deadline, personal, travel, focus)'),
      attendeeIds: z.array(z.string()).optional().describe('User IDs to invite as attendees'),
      pageId: z.string().nullable().optional().describe('Optional page ID to link this event to'),
    }),
    execute: async (
      {
        title,
        startAt,
        endAt,
        driveId,
        description,
        location,
        allDay: allDayInput,
        timezone: timezoneInput,
        recurrence,
        visibility: visibilityInput,
        color: colorInput,
        attendeeIds,
        pageId,
      },
      { experimental_context: ctx }
    ) => {
      const userId = (ctx as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      // Apply defaults
      const allDay = allDayInput ?? false;
      const timezone = timezoneInput ?? 'UTC';
      const visibility = visibilityInput ?? 'DRIVE';
      const color = colorInput ?? 'default';

      try {
        // Parse dates
        const parsedStartAt = parseDateTime(startAt);
        const parsedEndAt = parseDateTime(endAt, parsedStartAt);

        // Default end time to 1 hour after start if they're the same
        if (parsedEndAt.getTime() === parsedStartAt.getTime()) {
          parsedEndAt.setHours(parsedEndAt.getHours() + 1);
        }

        if (parsedEndAt <= parsedStartAt) {
          return {
            success: false,
            error: 'End date must be after start date.',
          };
        }

        // Validate drive access if driveId is provided
        if (driveId) {
          const canAccess = await isUserDriveMember(userId, driveId);
          if (!canAccess) {
            return {
              success: false,
              error: 'You do not have access to this drive.',
            };
          }
        }

        // Validate attendees constraints
        const otherAttendees = (attendeeIds ?? []).filter((id) => id !== userId);
        if (otherAttendees.length > 0) {
          // PRIVATE events cannot have additional attendees
          if (visibility === 'PRIVATE') {
            return {
              success: false,
              error: 'Private events cannot have attendees other than the creator.',
            };
          }

          // For drive events, verify all proposed attendees are drive members
          if (driveId) {
            const driveMemberIds = await getDriveMemberUserIds(driveId);
            const driveMemberSet = new Set(driveMemberIds);
            const nonMembers = otherAttendees.filter((id) => !driveMemberSet.has(id));

            if (nonMembers.length > 0) {
              return {
                success: false,
                error: `All attendees must be members of the drive. ${nonMembers.length} user(s) are not members.`,
              };
            }
          }
        }

        // Create the event
        const [event] = await db
          .insert(calendarEvents)
          .values({
            driveId: driveId ?? null,
            createdById: userId,
            pageId: pageId ?? null,
            title,
            description: description ?? null,
            location: location ?? null,
            startAt: parsedStartAt,
            endAt: parsedEndAt,
            allDay,
            timezone,
            recurrenceRule: recurrence ?? null,
            visibility,
            color,
            updatedAt: new Date(),
          })
          .returning();

        // Add creator as organizer attendee
        await db.insert(eventAttendees).values({
          eventId: event.id,
          userId: userId,
          status: 'ACCEPTED',
          isOrganizer: true,
          respondedAt: new Date(),
        });

        // Add other attendees if provided
        if (otherAttendees.length > 0) {
          await db.insert(eventAttendees).values(
            otherAttendees.map((attendeeId) => ({
              eventId: event.id,
              userId: attendeeId,
              status: 'PENDING' as const,
              isOrganizer: false,
            }))
          );
        }

        // Broadcast event creation
        await broadcastCalendarEvent({
          eventId: event.id,
          driveId: driveId ?? null,
          operation: 'created',
          userId,
          attendeeIds: [userId, ...otherAttendees],
        });

        calendarWriteLogger.info('Calendar event created via AI tool', {
          eventId: maskIdentifier(event.id),
          userId: maskIdentifier(userId),
          driveId: driveId ? maskIdentifier(driveId) : null,
          attendeeCount: otherAttendees.length + 1,
        });

        return {
          success: true,
          data: {
            id: event.id,
            title: event.title,
            startAt: event.startAt.toISOString(),
            endAt: event.endAt.toISOString(),
            driveId: event.driveId,
            visibility: event.visibility,
            attendeesInvited: otherAttendees.length,
          },
          summary: `Created "${title}" for ${parsedStartAt.toLocaleDateString()} at ${parsedStartAt.toLocaleTimeString()}${otherAttendees.length > 0 ? ` with ${otherAttendees.length} attendee${otherAttendees.length === 1 ? '' : 's'}` : ''}`,
          stats: {
            eventCount: 1,
            attendeesInvited: otherAttendees.length,
          },
          nextSteps: [
            'Use list_calendar_events to see upcoming meetings',
            'Use invite_calendar_attendees to add more participants',
            'Use update_calendar_event to modify event details',
          ],
        };
      } catch (error) {
        calendarWriteLogger.error('Failed to create calendar event', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          title,
        });
        throw new Error(
          `Failed to create calendar event: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  }),

  /**
   * Update an existing calendar event
   */
  update_calendar_event: tool({
    description:
      'Update an existing calendar event. Only the event creator can update events. Supports partial updates - only specify the fields you want to change.',
    inputSchema: z.object({
      eventId: z.string().describe('The unique ID of the event to update'),
      title: z.string().min(1).max(500).optional().describe('New event title'),
      startAt: z
        .string()
        .optional()
        .describe('New start date/time (ISO 8601 or natural language)'),
      endAt: z.string().optional().describe('New end date/time (ISO 8601 or natural language)'),
      description: z.string().max(10000).nullable().optional().describe('New event description'),
      location: z.string().max(1000).nullable().optional().describe('New event location'),
      allDay: z.boolean().optional().describe('Whether this is an all-day event'),
      timezone: z.string().optional().describe('New timezone'),
      recurrence: recurrenceRuleSchema.describe('New recurrence rule'),
      visibility: z
        .enum(['DRIVE', 'ATTENDEES_ONLY', 'PRIVATE'])
        .optional()
        .describe('New visibility setting'),
      color: z.string().optional().describe('New color category'),
      pageId: z.string().nullable().optional().describe('Page ID to link to'),
    }),
    execute: async (
      { eventId, title, startAt, endAt, description, location, allDay, timezone, recurrence, visibility, color, pageId },
      { experimental_context: ctx }
    ) => {
      const userId = (ctx as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Get existing event
        const event = await db.query.calendarEvents.findFirst({
          where: and(eq(calendarEvents.id, eventId), eq(calendarEvents.isTrashed, false)),
        });

        if (!event) {
          return {
            success: false,
            error: 'Event not found.',
          };
        }

        // Check edit permission
        const canEdit = await canEditEvent(userId, event);
        if (!canEdit) {
          return {
            success: false,
            error: 'Only the event creator can edit this event.',
          };
        }

        // Parse dates if provided
        const parsedStartAt = startAt ? parseDateTime(startAt) : undefined;
        const parsedEndAt = endAt ? parseDateTime(endAt, parsedStartAt ?? event.startAt) : undefined;

        // Validate dates
        const newStartAt = parsedStartAt ?? event.startAt;
        const newEndAt = parsedEndAt ?? event.endAt;
        if (newEndAt <= newStartAt) {
          return {
            success: false,
            error: 'End date must be after start date.',
          };
        }

        // Build update object with only provided fields
        const updates: Partial<typeof calendarEvents.$inferInsert> = {
          updatedAt: new Date(),
        };

        if (title !== undefined) updates.title = title;
        if (parsedStartAt !== undefined) updates.startAt = parsedStartAt;
        if (parsedEndAt !== undefined) updates.endAt = parsedEndAt;
        if (description !== undefined) updates.description = description;
        if (location !== undefined) updates.location = location;
        if (allDay !== undefined) updates.allDay = allDay;
        if (timezone !== undefined) updates.timezone = timezone;
        if (recurrence !== undefined) updates.recurrenceRule = recurrence;
        if (visibility !== undefined) updates.visibility = visibility;
        if (color !== undefined) updates.color = color;
        if (pageId !== undefined) updates.pageId = pageId;

        // Update the event
        const [updatedEvent] = await db
          .update(calendarEvents)
          .set(updates)
          .where(eq(calendarEvents.id, eventId))
          .returning();

        // Get all attendee IDs for broadcasting
        const attendeeIds = await getEventAttendeeIds(eventId);

        // Broadcast event update
        await broadcastCalendarEvent({
          eventId,
          driveId: updatedEvent.driveId,
          operation: 'updated',
          userId,
          attendeeIds,
        });

        calendarWriteLogger.info('Calendar event updated via AI tool', {
          eventId: maskIdentifier(eventId),
          userId: maskIdentifier(userId),
          updatedFields: Object.keys(updates).filter((k) => k !== 'updatedAt'),
        });

        return {
          success: true,
          data: {
            id: updatedEvent.id,
            title: updatedEvent.title,
            startAt: updatedEvent.startAt.toISOString(),
            endAt: updatedEvent.endAt.toISOString(),
          },
          summary: `Updated "${updatedEvent.title}"`,
          stats: {
            fieldsUpdated: Object.keys(updates).filter((k) => k !== 'updatedAt').length,
          },
          nextSteps: [
            'Use get_calendar_event to see the updated event details',
            'Use list_calendar_events to see all upcoming events',
          ],
        };
      } catch (error) {
        calendarWriteLogger.error('Failed to update calendar event', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          eventId: maskIdentifier(eventId),
        });
        throw new Error(
          `Failed to update calendar event: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  }),

  /**
   * Delete (soft) a calendar event
   */
  delete_calendar_event: tool({
    description: 'Delete a calendar event (moves to trash). Only the event creator can delete events.',
    inputSchema: z.object({
      eventId: z.string().describe('The unique ID of the event to delete'),
    }),
    execute: async ({ eventId }, { experimental_context: ctx }) => {
      const userId = (ctx as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Get existing event
        const event = await db.query.calendarEvents.findFirst({
          where: and(eq(calendarEvents.id, eventId), eq(calendarEvents.isTrashed, false)),
        });

        if (!event) {
          return {
            success: false,
            error: 'Event not found.',
          };
        }

        // Check edit permission
        const canEdit = await canEditEvent(userId, event);
        if (!canEdit) {
          return {
            success: false,
            error: 'Only the event creator can delete this event.',
          };
        }

        // Get all attendee IDs before deletion for broadcasting
        const attendeeIds = await getEventAttendeeIds(eventId);

        // Soft delete the event
        await db
          .update(calendarEvents)
          .set({
            isTrashed: true,
            trashedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(calendarEvents.id, eventId));

        // Broadcast event deletion
        await broadcastCalendarEvent({
          eventId,
          driveId: event.driveId,
          operation: 'deleted',
          userId,
          attendeeIds,
        });

        calendarWriteLogger.info('Calendar event deleted via AI tool', {
          eventId: maskIdentifier(eventId),
          userId: maskIdentifier(userId),
        });

        return {
          success: true,
          data: {
            id: event.id,
            title: event.title,
          },
          summary: `Deleted "${event.title}"`,
          stats: {
            deletedCount: 1,
            attendeesNotified: attendeeIds.length,
          },
          nextSteps: ['Use list_calendar_events to see remaining events', 'Use create_calendar_event to schedule a new event'],
        };
      } catch (error) {
        calendarWriteLogger.error('Failed to delete calendar event', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          eventId: maskIdentifier(eventId),
        });
        throw new Error(
          `Failed to delete calendar event: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  }),

  /**
   * Update RSVP status for the current user
   */
  rsvp_calendar_event: tool({
    description:
      'Update your RSVP status for a calendar event. You must be an attendee of the event to RSVP.',
    inputSchema: z.object({
      eventId: z.string().describe('The unique ID of the event'),
      status: z
        .enum(['ACCEPTED', 'DECLINED', 'TENTATIVE'])
        .describe('Your RSVP response: ACCEPTED (attending), DECLINED (not attending), TENTATIVE (might attend)'),
      responseNote: z
        .string()
        .max(500)
        .nullable()
        .optional()
        .describe('Optional note with your response'),
    }),
    execute: async ({ eventId, status, responseNote }, { experimental_context: ctx }) => {
      const userId = (ctx as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      try {
        // Verify event exists
        const event = await db.query.calendarEvents.findFirst({
          where: and(eq(calendarEvents.id, eventId), eq(calendarEvents.isTrashed, false)),
        });

        if (!event) {
          return {
            success: false,
            error: 'Event not found.',
          };
        }

        // Verify user is an attendee
        const attendee = await db.query.eventAttendees.findFirst({
          where: and(eq(eventAttendees.eventId, eventId), eq(eventAttendees.userId, userId)),
        });

        if (!attendee) {
          return {
            success: false,
            error: 'You are not an attendee of this event.',
          };
        }

        // Update RSVP
        const [updatedAttendee] = await db
          .update(eventAttendees)
          .set({
            status,
            responseNote: responseNote ?? null,
            respondedAt: new Date(),
          })
          .where(and(eq(eventAttendees.eventId, eventId), eq(eventAttendees.userId, userId)))
          .returning();

        // Broadcast RSVP update
        const allAttendeeIds = await getEventAttendeeIds(eventId);

        await broadcastCalendarEvent({
          eventId,
          driveId: event.driveId,
          operation: 'rsvp_updated',
          userId,
          attendeeIds: allAttendeeIds,
        });

        calendarWriteLogger.info('Calendar RSVP updated via AI tool', {
          eventId: maskIdentifier(eventId),
          userId: maskIdentifier(userId),
          status,
        });

        return {
          success: true,
          data: {
            eventId,
            eventTitle: event.title,
            status: updatedAttendee.status,
            responseNote: updatedAttendee.responseNote,
          },
          summary: `RSVP updated to ${status} for "${event.title}"`,
          stats: {
            rsvpStatus: status,
          },
          nextSteps: [
            'Use list_calendar_events to see your upcoming events',
            'Use get_calendar_event to see who else is attending',
          ],
        };
      } catch (error) {
        calendarWriteLogger.error('Failed to update RSVP', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          eventId: maskIdentifier(eventId),
        });
        throw new Error(`Failed to update RSVP: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),

  /**
   * Invite attendees to an event
   */
  invite_calendar_attendees: tool({
    description:
      'Add attendees to a calendar event. Only the event creator can invite attendees. For drive events, attendees must be drive members.',
    inputSchema: z.object({
      eventId: z.string().describe('The unique ID of the event'),
      userIds: z.array(z.string()).min(1).describe('User IDs to invite'),
      isOptional: z.boolean().optional().describe('Whether these attendees are optional (default: false)'),
    }),
    execute: async ({ eventId, userIds, isOptional: isOptionalInput }, { experimental_context: ctx }) => {
      const userId = (ctx as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      // Apply defaults
      const isOptional = isOptionalInput ?? false;

      try {
        // Verify event exists
        const event = await db.query.calendarEvents.findFirst({
          where: and(eq(calendarEvents.id, eventId), eq(calendarEvents.isTrashed, false)),
        });

        if (!event) {
          return {
            success: false,
            error: 'Event not found.',
          };
        }

        // Only creator can add attendees
        if (event.createdById !== userId) {
          return {
            success: false,
            error: 'Only the event creator can add attendees.',
          };
        }

        // PRIVATE events cannot have additional attendees
        if (event.visibility === 'PRIVATE') {
          return {
            success: false,
            error: 'Private events cannot have attendees other than the creator.',
          };
        }

        // Deduplicate userIds
        const uniqueUserIds = [...new Set(userIds)];

        // For drive events, verify all proposed attendees are drive members
        if (event.driveId) {
          const driveMemberIds = await getDriveMemberUserIds(event.driveId);
          const driveMemberSet = new Set(driveMemberIds);
          const nonMembers = uniqueUserIds.filter((id) => !driveMemberSet.has(id));

          if (nonMembers.length > 0) {
            return {
              success: false,
              error: `All attendees must be members of the drive. ${nonMembers.length} user(s) are not members.`,
            };
          }
        }

        // Get existing attendees to avoid duplicates
        const existingAttendees = await db
          .select({ userId: eventAttendees.userId })
          .from(eventAttendees)
          .where(eq(eventAttendees.eventId, eventId));

        const existingUserIds = new Set(existingAttendees.map((a) => a.userId));
        const newUserIds = uniqueUserIds.filter((id) => !existingUserIds.has(id));

        if (newUserIds.length === 0) {
          return {
            success: true,
            data: { newlyInvited: 0 },
            summary: 'All specified users are already attendees of this event.',
            stats: { alreadyAttendees: uniqueUserIds.length },
            nextSteps: ['Use get_calendar_event to see the attendee list'],
          };
        }

        // Add new attendees
        await db.insert(eventAttendees).values(
          newUserIds.map((attendeeId) => ({
            eventId,
            userId: attendeeId,
            status: 'PENDING' as const,
            isOrganizer: false,
            isOptional,
          }))
        );

        // Broadcast to new attendees
        await broadcastCalendarEvent({
          eventId,
          driveId: event.driveId,
          operation: 'updated',
          userId,
          attendeeIds: newUserIds,
        });

        calendarWriteLogger.info('Calendar attendees invited via AI tool', {
          eventId: maskIdentifier(eventId),
          userId: maskIdentifier(userId),
          invitedCount: newUserIds.length,
        });

        return {
          success: true,
          data: {
            eventId,
            eventTitle: event.title,
            newlyInvited: newUserIds.length,
            skippedExisting: uniqueUserIds.length - newUserIds.length,
          },
          summary: `Invited ${newUserIds.length} attendee${newUserIds.length === 1 ? '' : 's'} to "${event.title}"`,
          stats: {
            newlyInvited: newUserIds.length,
            skippedExisting: uniqueUserIds.length - newUserIds.length,
          },
          nextSteps: [
            'Use get_calendar_event to see all attendees and their RSVP status',
            'Attendees will receive invitations and can RSVP',
          ],
        };
      } catch (error) {
        calendarWriteLogger.error('Failed to invite calendar attendees', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          eventId: maskIdentifier(eventId),
        });
        throw new Error(
          `Failed to invite attendees: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  }),

  /**
   * Remove an attendee from an event
   */
  remove_calendar_attendee: tool({
    description:
      'Remove an attendee from a calendar event. Event creator can remove any attendee. Attendees can remove themselves.',
    inputSchema: z.object({
      eventId: z.string().describe('The unique ID of the event'),
      targetUserId: z
        .string()
        .optional()
        .describe('User ID to remove. If not specified, removes the current user.'),
    }),
    execute: async ({ eventId, targetUserId }, { experimental_context: ctx }) => {
      const userId = (ctx as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      const removeUserId = targetUserId ?? userId;

      try {
        // Verify event exists
        const event = await db.query.calendarEvents.findFirst({
          where: and(eq(calendarEvents.id, eventId), eq(calendarEvents.isTrashed, false)),
        });

        if (!event) {
          return {
            success: false,
            error: 'Event not found.',
          };
        }

        // Check permissions
        // Users can remove themselves, only creator can remove others
        if (removeUserId !== userId && event.createdById !== userId) {
          return {
            success: false,
            error: 'Only the event creator can remove other attendees.',
          };
        }

        // Cannot remove the organizer/creator
        const targetAttendee = await db.query.eventAttendees.findFirst({
          where: and(eq(eventAttendees.eventId, eventId), eq(eventAttendees.userId, removeUserId)),
        });

        if (!targetAttendee) {
          return {
            success: false,
            error: 'User is not an attendee of this event.',
          };
        }

        if (targetAttendee.isOrganizer) {
          return {
            success: false,
            error: 'Cannot remove the event organizer.',
          };
        }

        // Remove attendee
        await db
          .delete(eventAttendees)
          .where(and(eq(eventAttendees.eventId, eventId), eq(eventAttendees.userId, removeUserId)));

        // Broadcast removal
        await broadcastCalendarEvent({
          eventId,
          driveId: event.driveId,
          operation: 'updated',
          userId,
          attendeeIds: [removeUserId],
        });

        calendarWriteLogger.info('Calendar attendee removed via AI tool', {
          eventId: maskIdentifier(eventId),
          userId: maskIdentifier(userId),
          removedUserId: maskIdentifier(removeUserId),
        });

        return {
          success: true,
          data: {
            eventId,
            eventTitle: event.title,
            removedUserId: removeUserId,
          },
          summary:
            removeUserId === userId
              ? `You have been removed from "${event.title}"`
              : `Removed attendee from "${event.title}"`,
          stats: {
            removedCount: 1,
          },
          nextSteps: [
            'Use get_calendar_event to see the updated attendee list',
            'Use invite_calendar_attendees to add new participants',
          ],
        };
      } catch (error) {
        calendarWriteLogger.error('Failed to remove calendar attendee', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          eventId: maskIdentifier(eventId),
          targetUserId: maskIdentifier(removeUserId),
        });
        throw new Error(
          `Failed to remove attendee: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  }),
};
