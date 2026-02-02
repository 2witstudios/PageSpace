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
import { broadcastCalendarEvent } from '@/lib/websocket/calendar-events';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

// Schema for adding attendees
const addAttendeesSchema = z.object({
  userIds: z.array(z.string()).min(1),
  isOptional: z.boolean().default(false),
});

// Schema for updating RSVP status
const updateRsvpSchema = z.object({
  status: z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'TENTATIVE']),
  responseNote: z.string().max(500).nullable().optional(),
});

/**
 * GET /api/calendar/events/[eventId]/attendees
 *
 * Get all attendees for an event
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

  const _userId = auth.userId;

  try {
    // Verify event exists and user has access
    const event = await db.query.calendarEvents.findFirst({
      where: and(
        eq(calendarEvents.id, eventId),
        eq(calendarEvents.isTrashed, false)
      ),
    });

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Get attendees with user info
    const attendees = await db.query.eventAttendees.findMany({
      where: eq(eventAttendees.eventId, eventId),
      with: {
        user: {
          columns: { id: true, name: true, email: true, image: true },
        },
      },
    });

    return NextResponse.json({ attendees });
  } catch (error) {
    loggers.api.error('Error fetching event attendees:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch event attendees' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/calendar/events/[eventId]/attendees
 *
 * Add attendees to an event (only event creator can do this)
 */
export async function POST(
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
    // Verify event exists
    const event = await db.query.calendarEvents.findFirst({
      where: and(
        eq(calendarEvents.id, eventId),
        eq(calendarEvents.isTrashed, false)
      ),
    });

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Only creator can add attendees
    if (event.createdById !== userId) {
      return NextResponse.json(
        { error: 'Only the event creator can add attendees' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const parseResult = addAttendeesSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parseResult.error.issues },
        { status: 400 }
      );
    }

    const { userIds, isOptional } = parseResult.data;

    // Get existing attendees to avoid duplicates
    const existingAttendees = await db
      .select({ userId: eventAttendees.userId })
      .from(eventAttendees)
      .where(eq(eventAttendees.eventId, eventId));

    const existingUserIds = new Set(existingAttendees.map(a => a.userId));
    const newUserIds = userIds.filter(id => !existingUserIds.has(id));

    if (newUserIds.length === 0) {
      return NextResponse.json(
        { message: 'All users are already attendees' },
        { status: 200 }
      );
    }

    // Add new attendees
    await db.insert(eventAttendees).values(
      newUserIds.map(attendeeId => ({
        eventId,
        userId: attendeeId,
        status: 'PENDING' as const,
        isOrganizer: false,
        isOptional,
      }))
    );

    // Fetch updated attendees
    const attendees = await db.query.eventAttendees.findMany({
      where: eq(eventAttendees.eventId, eventId),
      with: {
        user: {
          columns: { id: true, name: true, email: true, image: true },
        },
      },
    });

    // Broadcast to new attendees
    await broadcastCalendarEvent({
      eventId,
      driveId: event.driveId,
      operation: 'updated',
      userId,
      attendeeIds: newUserIds,
    });

    return NextResponse.json({ attendees });
  } catch (error) {
    loggers.api.error('Error adding event attendees:', error as Error);
    return NextResponse.json(
      { error: 'Failed to add event attendees' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/calendar/events/[eventId]/attendees
 *
 * Update RSVP status for the current user
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
    // Verify event exists
    const event = await db.query.calendarEvents.findFirst({
      where: and(
        eq(calendarEvents.id, eventId),
        eq(calendarEvents.isTrashed, false)
      ),
    });

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Verify user is an attendee
    const attendee = await db.query.eventAttendees.findFirst({
      where: and(
        eq(eventAttendees.eventId, eventId),
        eq(eventAttendees.userId, userId)
      ),
    });

    if (!attendee) {
      return NextResponse.json(
        { error: 'You are not an attendee of this event' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const parseResult = updateRsvpSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parseResult.error.issues },
        { status: 400 }
      );
    }

    const { status, responseNote } = parseResult.data;

    // Update RSVP
    const [updatedAttendee] = await db
      .update(eventAttendees)
      .set({
        status,
        responseNote: responseNote ?? null,
        respondedAt: new Date(),
      })
      .where(
        and(
          eq(eventAttendees.eventId, eventId),
          eq(eventAttendees.userId, userId)
        )
      )
      .returning();

    // Broadcast RSVP update to event creator and other attendees
    const allAttendees = await db
      .select({ userId: eventAttendees.userId })
      .from(eventAttendees)
      .where(eq(eventAttendees.eventId, eventId));

    await broadcastCalendarEvent({
      eventId,
      driveId: event.driveId,
      operation: 'rsvp_updated',
      userId,
      attendeeIds: allAttendees.map(a => a.userId),
    });

    return NextResponse.json(updatedAttendee);
  } catch (error) {
    loggers.api.error('Error updating RSVP:', error as Error);
    return NextResponse.json(
      { error: 'Failed to update RSVP' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/calendar/events/[eventId]/attendees
 *
 * Remove an attendee from the event (only creator can remove others, anyone can remove themselves)
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
  const { searchParams } = new URL(request.url);
  const targetUserId = searchParams.get('userId') || userId;

  try {
    // Verify event exists
    const event = await db.query.calendarEvents.findFirst({
      where: and(
        eq(calendarEvents.id, eventId),
        eq(calendarEvents.isTrashed, false)
      ),
    });

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Check permissions
    // Users can remove themselves, only creator can remove others
    if (targetUserId !== userId && event.createdById !== userId) {
      return NextResponse.json(
        { error: 'Only the event creator can remove other attendees' },
        { status: 403 }
      );
    }

    // Cannot remove the organizer/creator
    const targetAttendee = await db.query.eventAttendees.findFirst({
      where: and(
        eq(eventAttendees.eventId, eventId),
        eq(eventAttendees.userId, targetUserId)
      ),
    });

    if (!targetAttendee) {
      return NextResponse.json(
        { error: 'User is not an attendee of this event' },
        { status: 404 }
      );
    }

    if (targetAttendee.isOrganizer) {
      return NextResponse.json(
        { error: 'Cannot remove the event organizer' },
        { status: 400 }
      );
    }

    // Remove attendee
    await db
      .delete(eventAttendees)
      .where(
        and(
          eq(eventAttendees.eventId, eventId),
          eq(eventAttendees.userId, targetUserId)
        )
      );

    // Broadcast removal
    await broadcastCalendarEvent({
      eventId,
      driveId: event.driveId,
      operation: 'updated',
      userId,
      attendeeIds: [targetUserId],
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error removing event attendee:', error as Error);
    return NextResponse.json(
      { error: 'Failed to remove event attendee' },
      { status: 500 }
    );
  }
}
