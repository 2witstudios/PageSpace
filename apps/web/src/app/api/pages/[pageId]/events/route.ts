import { NextResponse } from 'next/server';
import { pages, db, eq } from '@pagespace/db';
import { canUserEditPage } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { PageType } from '@pagespace/lib/enums';
import {
  parseCalendarContent,
  serializeCalendarContent,
  CalendarEvent,
  EventCreateRequest,
} from '@pagespace/lib/calendar-types';
import {
  validateEvent,
  generateEventId,
} from '@pagespace/lib/calendar-utils';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/socket-utils';
import { trackPageOperation } from '@pagespace/lib/activity-tracker';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };

/**
 * POST /api/pages/[pageId]/events
 * Creates a new event on a calendar page
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  try {
    // Await params (Next.js 15 requirement)
    const { pageId } = await context.params;

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
    const body: EventCreateRequest = await request.json();

    // Validate event data
    const validation = validateEvent({
      title: body.title,
      description: body.description,
      start: body.start,
      end: body.end,
      color: body.color,
    });

    if (!validation.valid) {
      return NextResponse.json(
        { error: 'Invalid event data', details: validation.errors },
        { status: 400 }
      );
    }

    // Parse calendar content
    const calendarContent = parseCalendarContent(calendarPage.content);

    // Create new event
    const newEvent: CalendarEvent = {
      id: generateEventId(),
      title: body.title,
      description: body.description,
      start: body.start,
      end: body.end,
      allDay: body.allDay || false,
      color: body.color,
      attendees: body.attendees || [],
      recurrence: body.recurrence,
      sourcePageId: pageId,
      createdBy: user.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Add event to calendar
    calendarContent.events.push(newEvent);

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
    await trackPageOperation(user.id, pageId, 'calendar_event_created', {
      eventId: newEvent.id,
      eventTitle: newEvent.title,
    });

    // Broadcast real-time update
    await broadcastPageEvent('calendar:event:created', {
      pageId,
      event: newEvent,
      userId: user.id,
    });

    return NextResponse.json(newEvent, { status: 201 });
  } catch (error) {
    console.error('Error creating calendar event:', error);
    return NextResponse.json(
      { error: 'Failed to create calendar event' },
      { status: 500 }
    );
  }
}
