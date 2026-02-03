import { tool } from 'ai';
import { z } from 'zod';
import {
  db,
  calendarEvents,
  eventAttendees,
  eq,
  and,
  or,
  gte,
  lte,
  inArray,
  isNull,
  desc,
  not,
} from '@pagespace/db';
import { isUserDriveMember, getDriveIdsForUser } from '@pagespace/lib';
import { type ToolExecutionContext } from '../core';

/**
 * Check if user can access an event based on visibility rules
 */
async function canAccessEvent(
  userId: string,
  event: typeof calendarEvents.$inferSelect
): Promise<boolean> {
  // Creator always has access
  if (event.createdById === userId) {
    return true;
  }

  // Check if user is an attendee
  const attendee = await db.query.eventAttendees.findFirst({
    where: and(
      eq(eventAttendees.eventId, event.id),
      eq(eventAttendees.userId, userId)
    ),
  });
  if (attendee) {
    return true;
  }

  // Check drive membership for drive events with DRIVE visibility
  if (event.driveId && event.visibility === 'DRIVE') {
    return isUserDriveMember(userId, event.driveId);
  }

  return false;
}

/**
 * Format event for AI response
 */
function formatEventForResponse(event: {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startAt: Date;
  endAt: Date;
  allDay: boolean;
  timezone: string;
  visibility: string;
  color: string | null;
  recurrenceRule: unknown;
  driveId: string | null;
  createdById: string;
  createdBy?: { id: string; name: string | null; image: string | null } | null;
  attendees?: Array<{
    id: string;
    status: string;
    isOrganizer: boolean;
    isOptional: boolean;
    user: { id: string; name: string | null; image: string | null } | null;
  }>;
  page?: { id: string; title: string; type: string } | null;
  drive?: { id: string; name: string; slug: string } | null;
}) {
  return {
    id: event.id,
    title: event.title,
    description: event.description,
    location: event.location,
    startAt: event.startAt.toISOString(),
    endAt: event.endAt.toISOString(),
    allDay: event.allDay,
    timezone: event.timezone,
    visibility: event.visibility,
    color: event.color,
    recurrenceRule: event.recurrenceRule,
    driveId: event.driveId,
    createdById: event.createdById,
    ...(event.createdBy && {
      createdBy: {
        id: event.createdBy.id,
        name: event.createdBy.name,
      },
    }),
    ...(event.attendees && {
      attendees: event.attendees.map((a) => ({
        userId: a.user?.id,
        name: a.user?.name,
        status: a.status,
        isOrganizer: a.isOrganizer,
        isOptional: a.isOptional,
      })),
    }),
    ...(event.page && {
      linkedPage: {
        id: event.page.id,
        title: event.page.title,
        type: event.page.type,
      },
    }),
    ...(event.drive && {
      drive: {
        id: event.drive.id,
        name: event.drive.name,
        slug: event.drive.slug,
      },
    }),
  };
}

export const calendarReadTools = {
  /**
   * List calendar events in a date range
   */
  list_calendar_events: tool({
    description:
      'List calendar events within a date range. Can query personal calendar, a specific drive calendar, or all accessible calendars. Returns event details including title, time, attendees, and visibility.',
    inputSchema: z.object({
      startDate: z
        .string()
        .describe('Start date for query range (ISO 8601 format, e.g., "2024-01-15" or "2024-01-15T09:00:00Z")'),
      endDate: z
        .string()
        .describe('End date for query range (ISO 8601 format, e.g., "2024-01-20" or "2024-01-20T17:00:00Z")'),
      context: z
        .enum(['user', 'drive'])
        .optional()
        .describe('Query context: "user" for all accessible calendars (default), "drive" for a specific drive calendar'),
      driveId: z
        .string()
        .optional()
        .describe('Drive ID to query (required when context is "drive")'),
      includePersonal: z
        .boolean()
        .optional()
        .describe('Include personal (non-drive) events when context is "user" (default: true)'),
    }),
    execute: async (
      { startDate, endDate, context: contextInput, driveId, includePersonal: includePersonalInput },
      { experimental_context: ctx }
    ) => {
      const userId = (ctx as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      // Apply defaults
      const context = contextInput ?? 'user';
      const includePersonal = includePersonalInput ?? true;

      try {
        const parsedStartDate = new Date(startDate);
        const parsedEndDate = new Date(endDate);

        if (isNaN(parsedStartDate.getTime()) || isNaN(parsedEndDate.getTime())) {
          return {
            success: false,
            error: 'Invalid date format. Use ISO 8601 format (e.g., "2024-01-15" or "2024-01-15T09:00:00Z").',
          };
        }

        if (parsedEndDate <= parsedStartDate) {
          return {
            success: false,
            error: 'End date must be after start date.',
          };
        }

        if (context === 'drive') {
          if (!driveId) {
            return {
              success: false,
              error: 'driveId is required when context is "drive".',
            };
          }

          const canView = await isUserDriveMember(userId, driveId);
          if (!canView) {
            return {
              success: false,
              error: 'You do not have access to this drive.',
            };
          }

          // Get event IDs where user is an attendee (for ATTENDEES_ONLY events)
          const attendeeEventsInDrive = await db
            .select({ eventId: eventAttendees.eventId })
            .from(eventAttendees)
            .innerJoin(calendarEvents, eq(calendarEvents.id, eventAttendees.eventId))
            .where(
              and(
                eq(eventAttendees.userId, userId),
                eq(calendarEvents.driveId, driveId)
              )
            );
          const attendeeEventIdsInDrive = attendeeEventsInDrive.map((e) => e.eventId);

          const events = await db.query.calendarEvents.findMany({
            where: and(
              eq(calendarEvents.driveId, driveId),
              eq(calendarEvents.isTrashed, false),
              lte(calendarEvents.startAt, parsedEndDate),
              gte(calendarEvents.endAt, parsedStartDate),
              or(
                eq(calendarEvents.visibility, 'DRIVE'),
                and(
                  eq(calendarEvents.visibility, 'PRIVATE'),
                  eq(calendarEvents.createdById, userId)
                ),
                and(
                  eq(calendarEvents.visibility, 'ATTENDEES_ONLY'),
                  or(
                    eq(calendarEvents.createdById, userId),
                    attendeeEventIdsInDrive.length > 0
                      ? inArray(calendarEvents.id, attendeeEventIdsInDrive)
                      : eq(calendarEvents.id, '__never_match__')
                  )
                )
              )
            ),
            with: {
              createdBy: {
                columns: { id: true, name: true, image: true },
              },
              attendees: {
                with: {
                  user: {
                    columns: { id: true, name: true, image: true },
                  },
                },
              },
              page: {
                columns: { id: true, title: true, type: true },
              },
            },
            orderBy: [desc(calendarEvents.startAt)],
          });

          const formattedEvents = events.map(formatEventForResponse);

          return {
            success: true,
            data: { events: formattedEvents },
            summary: `Found ${events.length} event${events.length === 1 ? '' : 's'} in drive calendar from ${startDate} to ${endDate}`,
            stats: {
              eventCount: events.length,
              dateRange: { start: startDate, end: endDate },
              context: 'drive',
              driveId,
            },
            nextSteps:
              events.length > 0
                ? [
                    'Use get_calendar_event to see full details of a specific event',
                    'Use create_calendar_event to schedule new meetings',
                  ]
                : ['Use create_calendar_event to schedule a new event'],
          };
        }

        // User context: aggregate events from all sources
        const driveIds = await getDriveIdsForUser(userId);
        const conditions = [];

        // Personal events
        if (includePersonal) {
          conditions.push(
            and(isNull(calendarEvents.driveId), eq(calendarEvents.createdById, userId))
          );
        }

        // Drive events with DRIVE visibility
        if (driveIds.length > 0) {
          conditions.push(
            and(
              inArray(calendarEvents.driveId, driveIds),
              eq(calendarEvents.visibility, 'DRIVE')
            )
          );
        }

        // Events where user is an attendee
        const attendeeEvents = await db
          .select({ eventId: eventAttendees.eventId })
          .from(eventAttendees)
          .where(eq(eventAttendees.userId, userId));

        const attendeeEventIds = attendeeEvents.map((e) => e.eventId);
        if (attendeeEventIds.length > 0) {
          conditions.push(inArray(calendarEvents.id, attendeeEventIds));
        }

        if (conditions.length === 0) {
          return {
            success: true,
            data: { events: [] },
            summary: 'No calendar events found in the specified date range.',
            stats: {
              eventCount: 0,
              dateRange: { start: startDate, end: endDate },
              context: 'user',
            },
            nextSteps: ['Use create_calendar_event to schedule a new event'],
          };
        }

        const events = await db.query.calendarEvents.findMany({
          where: and(
            or(...conditions),
            eq(calendarEvents.isTrashed, false),
            lte(calendarEvents.startAt, parsedEndDate),
            gte(calendarEvents.endAt, parsedStartDate)
          ),
          with: {
            createdBy: {
              columns: { id: true, name: true, image: true },
            },
            attendees: {
              with: {
                user: {
                  columns: { id: true, name: true, image: true },
                },
              },
            },
            page: {
              columns: { id: true, title: true, type: true },
            },
            drive: {
              columns: { id: true, name: true, slug: true },
            },
          },
          orderBy: [desc(calendarEvents.startAt)],
        });

        const formattedEvents = events.map(formatEventForResponse);

        return {
          success: true,
          data: { events: formattedEvents },
          summary: `Found ${events.length} event${events.length === 1 ? '' : 's'} from ${startDate} to ${endDate}`,
          stats: {
            eventCount: events.length,
            dateRange: { start: startDate, end: endDate },
            context: 'user',
            includedDrives: driveIds.length,
            includePersonal,
          },
          nextSteps:
            events.length > 0
              ? [
                  'Use get_calendar_event to see full details of a specific event',
                  'Use create_calendar_event to schedule new meetings',
                ]
              : ['Use create_calendar_event to schedule a new event'],
        };
      } catch (error) {
        console.error('Error listing calendar events:', error);
        throw new Error(
          `Failed to list calendar events: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  }),

  /**
   * Get a single calendar event by ID
   */
  get_calendar_event: tool({
    description:
      'Get detailed information about a specific calendar event including all attendees and their RSVP status.',
    inputSchema: z.object({
      eventId: z.string().describe('The unique ID of the calendar event'),
      includeAttendees: z
        .boolean()
        .optional()
        .describe('Include attendee list with RSVP status (default: true)'),
    }),
    execute: async ({ eventId, includeAttendees: includeAttendeesInput }, { experimental_context: ctx }) => {
      const userId = (ctx as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      // Apply defaults
      const includeAttendees = includeAttendeesInput ?? true;

      try {
        const event = await db.query.calendarEvents.findFirst({
          where: and(
            eq(calendarEvents.id, eventId),
            eq(calendarEvents.isTrashed, false)
          ),
          with: {
            createdBy: {
              columns: { id: true, name: true, image: true },
            },
            ...(includeAttendees && {
              attendees: {
                with: {
                  user: {
                    columns: { id: true, name: true, image: true },
                  },
                },
              },
            }),
            page: {
              columns: { id: true, title: true, type: true },
            },
            drive: {
              columns: { id: true, name: true, slug: true },
            },
          },
        });

        if (!event) {
          return {
            success: false,
            error: 'Event not found.',
          };
        }

        // Check access
        const hasAccess = await canAccessEvent(userId, event);
        if (!hasAccess) {
          return {
            success: false,
            error: 'You do not have permission to view this event.',
          };
        }

        const formatted = formatEventForResponse(event as Parameters<typeof formatEventForResponse>[0]);

        // Calculate RSVP summary if attendees included
        let rsvpSummary: Record<string, number> | undefined;
        if (includeAttendees && event.attendees) {
          rsvpSummary = event.attendees.reduce(
            (acc, a) => {
              acc[a.status] = (acc[a.status] || 0) + 1;
              return acc;
            },
            {} as Record<string, number>
          );
        }

        return {
          success: true,
          data: { event: formatted },
          summary: `Event "${event.title}" on ${event.startAt.toLocaleDateString()} at ${event.startAt.toLocaleTimeString()}`,
          stats: {
            attendeeCount: event.attendees?.length ?? 0,
            ...(rsvpSummary && { rsvpSummary }),
          },
          nextSteps: [
            'Use update_calendar_event to modify event details',
            'Use rsvp_calendar_event to update your attendance status',
            'Use invite_calendar_attendees to add more participants',
          ],
        };
      } catch (error) {
        console.error('Error getting calendar event:', error);
        throw new Error(
          `Failed to get calendar event: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  }),

  /**
   * Check availability and find free time slots
   */
  check_calendar_availability: tool({
    description:
      'Find available time slots within a date range. Analyzes existing events to identify free periods of the requested duration.',
    inputSchema: z.object({
      startDate: z
        .string()
        .describe('Start date for availability check (ISO 8601 format)'),
      endDate: z.string().describe('End date for availability check (ISO 8601 format)'),
      durationMinutes: z
        .number()
        .int()
        .min(15)
        .max(480)
        .describe('Required duration in minutes (15-480)'),
      driveId: z
        .string()
        .optional()
        .describe('Optional drive ID to check availability for drive events'),
      workingHoursStart: z
        .number()
        .int()
        .min(0)
        .max(23)
        .optional()
        .describe('Start of working hours (0-23, default 9)'),
      workingHoursEnd: z
        .number()
        .int()
        .min(0)
        .max(23)
        .optional()
        .describe('End of working hours (0-23, default 17)'),
    }),
    execute: async (
      { startDate, endDate, durationMinutes, driveId, workingHoursStart: workingHoursStartInput, workingHoursEnd: workingHoursEndInput },
      { experimental_context: ctx }
    ) => {
      const userId = (ctx as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      // Apply defaults
      const workingHoursStart = workingHoursStartInput ?? 9;
      const workingHoursEnd = workingHoursEndInput ?? 17;

      try {
        const parsedStartDate = new Date(startDate);
        const parsedEndDate = new Date(endDate);

        if (isNaN(parsedStartDate.getTime()) || isNaN(parsedEndDate.getTime())) {
          return {
            success: false,
            error: 'Invalid date format. Use ISO 8601 format.',
          };
        }

        if (parsedEndDate <= parsedStartDate) {
          return {
            success: false,
            error: 'End date must be after start date.',
          };
        }

        // Validate drive access if specified
        if (driveId) {
          const canView = await isUserDriveMember(userId, driveId);
          if (!canView) {
            return {
              success: false,
              error: 'You do not have access to this drive.',
            };
          }
        }

        // Get user's events in the date range
        const driveIds = driveId ? [driveId] : await getDriveIdsForUser(userId);
        const conditions = [];

        // Personal events
        conditions.push(
          and(isNull(calendarEvents.driveId), eq(calendarEvents.createdById, userId))
        );

        // Drive events
        if (driveIds.length > 0) {
          conditions.push(inArray(calendarEvents.driveId, driveIds));
        }

        // Events where user is an attendee
        const attendeeEvents = await db
          .select({ eventId: eventAttendees.eventId })
          .from(eventAttendees)
          .where(eq(eventAttendees.userId, userId));
        const attendeeEventIds = attendeeEvents.map((e) => e.eventId);
        if (attendeeEventIds.length > 0) {
          conditions.push(inArray(calendarEvents.id, attendeeEventIds));
        }

        const events = await db.query.calendarEvents.findMany({
          where: and(
            or(...conditions),
            eq(calendarEvents.isTrashed, false),
            lte(calendarEvents.startAt, parsedEndDate),
            gte(calendarEvents.endAt, parsedStartDate)
          ),
          columns: {
            id: true,
            title: true,
            startAt: true,
            endAt: true,
            allDay: true,
          },
          orderBy: [calendarEvents.startAt],
        });

        // Find free slots
        const durationMs = durationMinutes * 60 * 1000;
        const freeSlots: Array<{ start: string; end: string; durationMinutes: number }> = [];

        // Create busy intervals from events
        const busyIntervals = events.map((e) => ({
          start: e.startAt.getTime(),
          end: e.endAt.getTime(),
        }));

        // Merge overlapping busy intervals
        busyIntervals.sort((a, b) => a.start - b.start);
        const mergedBusy: Array<{ start: number; end: number }> = [];
        for (const interval of busyIntervals) {
          const last = mergedBusy[mergedBusy.length - 1];
          if (last && interval.start <= last.end) {
            last.end = Math.max(last.end, interval.end);
          } else {
            mergedBusy.push({ ...interval });
          }
        }

        // Iterate through each day in the range
        const currentDate = new Date(parsedStartDate);
        currentDate.setHours(0, 0, 0, 0);

        while (currentDate < parsedEndDate) {
          const dayStart = new Date(currentDate);
          dayStart.setHours(workingHoursStart, 0, 0, 0);
          const dayEnd = new Date(currentDate);
          dayEnd.setHours(workingHoursEnd, 0, 0, 0);

          // Clamp to query range
          const effectiveStart = Math.max(dayStart.getTime(), parsedStartDate.getTime());
          const effectiveEnd = Math.min(dayEnd.getTime(), parsedEndDate.getTime());

          if (effectiveStart < effectiveEnd) {
            // Find free slots within this day's working hours
            let slotStart = effectiveStart;

            for (const busy of mergedBusy) {
              if (busy.start >= effectiveEnd) break;
              if (busy.end <= effectiveStart) continue;

              // Check for gap before this busy period
              const gapEnd = Math.min(busy.start, effectiveEnd);
              if (gapEnd - slotStart >= durationMs) {
                freeSlots.push({
                  start: new Date(slotStart).toISOString(),
                  end: new Date(gapEnd).toISOString(),
                  durationMinutes: Math.floor((gapEnd - slotStart) / 60000),
                });
              }
              slotStart = Math.max(slotStart, busy.end);
            }

            // Check for remaining time after last busy period
            if (effectiveEnd - slotStart >= durationMs) {
              freeSlots.push({
                start: new Date(slotStart).toISOString(),
                end: new Date(effectiveEnd).toISOString(),
                durationMinutes: Math.floor((effectiveEnd - slotStart) / 60000),
              });
            }
          }

          // Move to next day
          currentDate.setDate(currentDate.getDate() + 1);
        }

        // Limit to reasonable number of slots
        const limitedSlots = freeSlots.slice(0, 20);

        return {
          success: true,
          data: {
            freeSlots: limitedSlots,
            hasMore: freeSlots.length > 20,
          },
          summary:
            limitedSlots.length > 0
              ? `Found ${limitedSlots.length} free slot${limitedSlots.length === 1 ? '' : 's'} of at least ${durationMinutes} minutes between ${startDate} and ${endDate}`
              : `No free slots of ${durationMinutes} minutes found between ${startDate} and ${endDate}`,
          stats: {
            totalFreeSlots: freeSlots.length,
            busyEventsCount: events.length,
            requestedDurationMinutes: durationMinutes,
            workingHours: { start: workingHoursStart, end: workingHoursEnd },
          },
          nextSteps:
            limitedSlots.length > 0
              ? ['Use create_calendar_event to schedule an event in one of the free slots']
              : ['Try adjusting the date range or duration', 'Consider checking individual days'],
        };
      } catch (error) {
        console.error('Error checking calendar availability:', error);
        throw new Error(
          `Failed to check availability: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  }),
};
