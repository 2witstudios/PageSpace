import { NextResponse } from 'next/server';
import { pages, db, eq } from '@pagespace/db';
import { canUserEditPage } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { PageType } from '@pagespace/lib/enums';
import {
  parseCalendarContent,
  serializeCalendarContent,
  EventCreateRequest,
} from '@pagespace/lib/calendar-types';
import { validateEvent } from '@pagespace/lib/calendar-utils';
import { broadcastPageEvent } from '@/lib/socket-utils';
import { trackPageOperation } from '@pagespace/lib/activity-tracker';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };

/**
 * PATCH /api/pages/[pageId]/events/[eventId]
 * Updates an existing event on a calendar page
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ pageId: string; eventId: string }> }
) {
  try {
    // Await params (Next.js 15 requirement)
    const { pageId, eventId } = await context.params;

    // Authenticate request
    const authResult = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(authResult)) {
      return authResult;
    }
    const { user } = authResult;

    // Check if user has EDIT permission on the calendar page
    const canEdit = await canUserEditPage(user.id, pageId);
    if (!canEdit) {
      return NextResponse.json(
        { error: 'You do not have permission to edit this calendar' },
        { status: 403 }
      );
    }

    // Fetch the calendar page
    const [calendarPage] = await db
      .select()
      .from(pages)
      .where(eq(pages.id, pageId))
      .limit(1);

    if (!calendarPage) {
      return NextResponse.json(
        { error: 'Calendar page not found' },
        { status: 404 }
      );
    }

    if (calendarPage.type !== PageType.CALENDAR) {
      return NextResponse.json(
        { error: 'Page is not a calendar' },
        { status: 400 }
      );
    }

    // Parse request body
    const body: Partial<EventCreateRequest> = await request.json();

    // Parse calendar content
    const calendarContent = parseCalendarContent(calendarPage.content);

    // Find the event to update
    const eventIndex = calendarContent.events.findIndex(e => e.id === eventId);
    if (eventIndex === -1) {
      return NextResponse.json(
        { error: 'Event not found' },
        { status: 404 }
      );
    }

    const existingEvent = calendarContent.events[eventIndex];

    // Merge updates
    const updatedEvent = {
      ...existingEvent,
      ...(body.title !== undefined && { title: body.title }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.start !== undefined && { start: body.start }),
      ...(body.end !== undefined && { end: body.end }),
      ...(body.allDay !== undefined && { allDay: body.allDay }),
      ...(body.color !== undefined && { color: body.color }),
      ...(body.attendees !== undefined && { attendees: body.attendees }),
      ...(body.recurrence !== undefined && { recurrence: body.recurrence }),
      updatedAt: new Date().toISOString(),
    };

    // Validate updated event
    const validation = validateEvent(updatedEvent);
    if (!validation.valid) {
      return NextResponse.json(
        { error: 'Invalid event data', details: validation.errors },
        { status: 400 }
      );
    }

    // Update event in array
    calendarContent.events[eventIndex] = updatedEvent;

    // Serialize and save
    const updatedContent = serializeCalendarContent(calendarContent);
    await db
      .update(pages)
      .set({
        content: updatedContent,
        updatedAt: new Date(),
      })
      .where(eq(pages.id, pageId));

    // Track activity
    await trackPageOperation(user.id, pageId, 'calendar_event_updated', {
      eventId: updatedEvent.id,
      eventTitle: updatedEvent.title,
    });

    // Broadcast real-time update
    await broadcastPageEvent('calendar:event:updated', {
      pageId,
      eventId,
      event: updatedEvent,
      userId: user.id,
    });

    return NextResponse.json(updatedEvent);
  } catch (error) {
    console.error('Error updating calendar event:', error);
    return NextResponse.json(
      { error: 'Failed to update calendar event' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/pages/[pageId]/events/[eventId]
 * Deletes an event from a calendar page
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ pageId: string; eventId: string }> }
) {
  try {
    // Await params (Next.js 15 requirement)
    const { pageId, eventId } = await context.params;

    // Authenticate request
    const authResult = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(authResult)) {
      return authResult;
    }
    const { user } = authResult;

    // Check if user has EDIT permission on the calendar page
    const canEdit = await canUserEditPage(user.id, pageId);
    if (!canEdit) {
      return NextResponse.json(
        { error: 'You do not have permission to edit this calendar' },
        { status: 403 }
      );
    }

    // Fetch the calendar page
    const [calendarPage] = await db
      .select()
      .from(pages)
      .where(eq(pages.id, pageId))
      .limit(1);

    if (!calendarPage) {
      return NextResponse.json(
        { error: 'Calendar page not found' },
        { status: 404 }
      );
    }

    if (calendarPage.type !== PageType.CALENDAR) {
      return NextResponse.json(
        { error: 'Page is not a calendar' },
        { status: 400 }
      );
    }

    // Parse calendar content
    const calendarContent = parseCalendarContent(calendarPage.content);

    // Find the event to delete
    const eventIndex = calendarContent.events.findIndex(e => e.id === eventId);
    if (eventIndex === -1) {
      return NextResponse.json(
        { error: 'Event not found' },
        { status: 404 }
      );
    }

    const deletedEvent = calendarContent.events[eventIndex];

    // Remove event from array
    calendarContent.events.splice(eventIndex, 1);

    // Serialize and save
    const updatedContent = serializeCalendarContent(calendarContent);
    await db
      .update(pages)
      .set({
        content: updatedContent,
        updatedAt: new Date(),
      })
      .where(eq(pages.id, pageId));

    // Track activity
    await trackPageOperation(user.id, pageId, 'calendar_event_deleted', {
      eventId: deletedEvent.id,
      eventTitle: deletedEvent.title,
    });

    // Broadcast real-time update
    await broadcastPageEvent('calendar:event:deleted', {
      pageId,
      eventId,
      userId: user.id,
    });

    return NextResponse.json({ success: true, message: 'Event deleted' });
  } catch (error) {
    console.error('Error deleting calendar event:', error);
    return NextResponse.json(
      { error: 'Failed to delete calendar event' },
      { status: 500 }
    );
  }
}
