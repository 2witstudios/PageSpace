import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  db,
  calendarEvents,
  eventAttendees,
  eq,
  and,
} from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isUserDriveMember } from '@pagespace/lib';
import { broadcastCalendarEvent } from '@/lib/websocket/calendar-events';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

// Schema for updating an event
const updateEventSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).nullable().optional(),
  location: z.string().max(1000).nullable().optional(),
  startAt: z.coerce.date().optional(),
  endAt: z.coerce.date().optional(),
  allDay: z.boolean().optional(),
  timezone: z.string().optional(),
  recurrenceRule: z.object({
    frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
    interval: z.number().int().min(1).default(1),
    byDay: z.array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])).optional(),
    byMonthDay: z.array(z.number().int().min(1).max(31)).optional(),
    byMonth: z.array(z.number().int().min(1).max(12)).optional(),
    count: z.number().int().min(1).optional(),
    until: z.string().optional(),
  }).nullable().optional(),
  visibility: z.enum(['DRIVE', 'ATTENDEES_ONLY', 'PRIVATE']).optional(),
  color: z.string().optional(),
  pageId: z.string().nullable().optional(),
});

/**
 * Check if user can access an event
 */
async function canAccessEvent(userId: string, event: typeof calendarEvents.$inferSelect): Promise<boolean> {
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
 * Check if user can edit an event (only creator or drive admin)
 */
async function canEditEvent(userId: string, event: typeof calendarEvents.$inferSelect): Promise<boolean> {
  // Only creator can edit for now
  // TODO: Add drive admin check
  return event.createdById === userId;
}

/**
 * GET /api/calendar/events/[eventId]
 *
 * Get a single calendar event by ID
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ eventId: string }> }
) {
  const { eventId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;

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
    });

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Check access
    const hasAccess = await canAccessEvent(userId, event);
    if (!hasAccess) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    return NextResponse.json(event);
  } catch (error) {
    loggers.api.error('Error fetching calendar event:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch calendar event' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/calendar/events/[eventId]
 *
 * Update a calendar event
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ eventId: string }> }
) {
  const { eventId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;

  try {
    // Get existing event
    const event = await db.query.calendarEvents.findFirst({
      where: and(
        eq(calendarEvents.id, eventId),
        eq(calendarEvents.isTrashed, false)
      ),
    });

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Check edit permission
    const canEdit = await canEditEvent(userId, event);
    if (!canEdit) {
      return NextResponse.json(
        { error: 'Only the event creator can edit this event' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const parseResult = updateEventSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parseResult.error.issues },
        { status: 400 }
      );
    }

    const data = parseResult.data;

    // Validate dates if both are provided
    const newStartAt = data.startAt ?? event.startAt;
    const newEndAt = data.endAt ?? event.endAt;
    if (newEndAt <= newStartAt) {
      return NextResponse.json(
        { error: 'End date must be after start date' },
        { status: 400 }
      );
    }

    // Update the event
    const [updatedEvent] = await db
      .update(calendarEvents)
      .set({
        title: data.title,
        description: data.description,
        location: data.location,
        startAt: data.startAt,
        endAt: data.endAt,
        allDay: data.allDay,
        timezone: data.timezone,
        recurrenceRule: data.recurrenceRule,
        visibility: data.visibility,
        color: data.color,
        pageId: data.pageId,
        updatedAt: new Date(),
      })
      .where(eq(calendarEvents.id, eventId))
      .returning();

    // Fetch complete event with relations
    const completeEvent = await db.query.calendarEvents.findFirst({
      where: eq(calendarEvents.id, eventId),
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
    });

    // Get all attendee IDs for broadcasting
    const attendees = await db
      .select({ userId: eventAttendees.userId })
      .from(eventAttendees)
      .where(eq(eventAttendees.eventId, eventId));

    // Broadcast event update
    await broadcastCalendarEvent({
      eventId,
      driveId: updatedEvent.driveId,
      operation: 'updated',
      userId,
      attendeeIds: attendees.map(a => a.userId),
    });

    return NextResponse.json(completeEvent);
  } catch (error) {
    loggers.api.error('Error updating calendar event:', error as Error);
    return NextResponse.json(
      { error: 'Failed to update calendar event' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/calendar/events/[eventId]
 *
 * Soft delete a calendar event (move to trash)
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ eventId: string }> }
) {
  const { eventId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;

  try {
    // Get existing event
    const event = await db.query.calendarEvents.findFirst({
      where: and(
        eq(calendarEvents.id, eventId),
        eq(calendarEvents.isTrashed, false)
      ),
    });

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Check edit permission
    const canEdit = await canEditEvent(userId, event);
    if (!canEdit) {
      return NextResponse.json(
        { error: 'Only the event creator can delete this event' },
        { status: 403 }
      );
    }

    // Get all attendee IDs before deletion for broadcasting
    const attendees = await db
      .select({ userId: eventAttendees.userId })
      .from(eventAttendees)
      .where(eq(eventAttendees.eventId, eventId));

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
      attendeeIds: attendees.map(a => a.userId),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error deleting calendar event:', error as Error);
    return NextResponse.json(
      { error: 'Failed to delete calendar event' },
      { status: 500 }
    );
  }
}
