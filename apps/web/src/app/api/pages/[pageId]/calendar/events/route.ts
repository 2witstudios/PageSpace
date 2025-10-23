import { NextResponse } from 'next/server';
import { db, pages, eq, and } from '@pagespace/db';
import { authenticateRequestWithOptions, AUTH_OPTIONS } from '@/lib/auth-utils';
import { canUserEditPage } from '@pagespace/lib/server';
import { PageType } from '@pagespace/lib/enums';
import {
  parseCalendarContent,
  serializeCalendarContent,
  CalendarEvent,
  CalendarDoc,
} from '@pagespace/lib/calendar';
import { validateRecurrenceRule } from '@pagespace/lib/calendar/recurrence';
import { getAggregatedEvents } from '@pagespace/lib/services/calendar-aggregation';
import { calendarCache } from '@pagespace/lib/services/calendar-cache';
import { createId } from '@paralleldrive/cuid2';
import { z } from 'zod';

// Validation schema for creating/updating events
const eventSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  start: z.string().datetime(), // ISO 8601
  end: z.string().datetime(),
  allDay: z.boolean().optional().default(false),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(), // Hex color
  attendees: z.array(z.string()).optional(),
  recurrence: z.object({
    freq: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
    interval: z.number().int().min(1),
    until: z.string().datetime().optional(),
    count: z.number().int().min(1).optional(),
    by_weekday: z.array(z.string()).optional(),
    by_monthday: z.array(z.number().int().min(1).max(31)).optional(),
  }).optional(),
});

/**
 * GET /api/pages/[pageId]/calendar/events
 * List all events for a calendar, with optional date range filtering
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (!auth.isAuthenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // CRITICAL: Await params in Next.js 15
    const { pageId } = await context.params;

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const startDate = searchParams.get('startDate') || undefined;
    const endDate = searchParams.get('endDate') || undefined;
    const includeAggregated = searchParams.get('includeAggregated') !== 'false';

    // Try to get from cache first
    const cached = await calendarCache.getCachedEvents(pageId, startDate, endDate);
    if (cached) {
      return NextResponse.json(cached);
    }

    // Fetch aggregated events (handles permissions internally)
    const result = await getAggregatedEvents(
      auth.userId,
      pageId,
      startDate,
      endDate
    );

    // Cache the result
    await calendarCache.setCachedEvents(pageId, result, startDate, endDate);

    // Return based on includeAggregated flag
    if (includeAggregated) {
      return NextResponse.json(result);
    } else {
      // Return only own events
      return NextResponse.json({
        ownEvents: result.ownEvents,
        aggregatedEvents: [],
        flatEvents: result.ownEvents,
      });
    }
  } catch (error) {
    console.error('Error fetching calendar events:', error);

    if (error instanceof Error && error.message.includes('permission')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    return NextResponse.json(
      { error: 'Failed to fetch calendar events' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/pages/[pageId]/calendar/events
 * Create a new event in a calendar
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (!auth.isAuthenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // CRITICAL: Await params in Next.js 15
    const { pageId } = await context.params;

    // Parse request body
    const body = await request.json();

    // Validate input
    const validationResult = eventSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        { error: 'Invalid event data', details: validationResult.error.errors },
        { status: 400 }
      );
    }

    const eventData = validationResult.data;

    // Validate date range
    const startDate = new Date(eventData.start);
    const endDate = new Date(eventData.end);
    if (endDate <= startDate) {
      return NextResponse.json(
        { error: 'End date must be after start date' },
        { status: 400 }
      );
    }

    // Validate recurrence rule if provided
    if (eventData.recurrence) {
      const recurrenceValidation = validateRecurrenceRule(eventData.recurrence);
      if (!recurrenceValidation.valid) {
        return NextResponse.json(
          { error: recurrenceValidation.error },
          { status: 400 }
        );
      }
    }

    // Fetch calendar page
    const calendarPage = await db.query.pages.findFirst({
      where: and(
        eq(pages.id, pageId),
        eq(pages.isTrashed, false)
      ),
    });

    if (!calendarPage || calendarPage.type !== PageType.CALENDAR) {
      return NextResponse.json(
        { error: 'Calendar page not found' },
        { status: 404 }
      );
    }

    // Check edit permission
    const canEdit = await canUserEditPage(auth.userId, pageId);
    if (!canEdit) {
      return NextResponse.json(
        { error: 'Insufficient permissions to edit this calendar' },
        { status: 403 }
      );
    }

    // Parse calendar content
    const calendar: CalendarDoc = parseCalendarContent(calendarPage.content);

    // Create new event
    const now = new Date().toISOString();
    const newEvent: CalendarEvent = {
      id: createId(),
      title: eventData.title,
      description: eventData.description,
      start: eventData.start,
      end: eventData.end,
      all_day: eventData.allDay || false,
      color: eventData.color,
      attendees: eventData.attendees,
      recurrence: eventData.recurrence,
      created_at: now,
      created_by: auth.userId,
      updated_at: now,
    };

    // Add event to calendar
    calendar.events.push(newEvent);

    // Serialize back to TOML
    const updatedContent = serializeCalendarContent(calendar, { pageId });

    // Update database
    await db.update(pages)
      .set({
        content: updatedContent,
        updatedAt: new Date(),
      })
      .where(eq(pages.id, pageId));

    // Invalidate cache
    await calendarCache.invalidateCalendar(pageId);

    // TODO: Broadcast real-time event (will implement in Phase 5)
    // await broadcastCalendarEvent({
    //   calendarId: pageId,
    //   eventId: newEvent.id,
    //   operation: 'event_created',
    //   driveId: calendarPage.driveId,
    //   title: newEvent.title,
    //   socketId: request.headers.get('X-Socket-ID') || undefined
    // });

    return NextResponse.json(
      {
        success: true,
        event: newEvent,
        message: 'Event created successfully',
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Error creating calendar event:', error);
    return NextResponse.json(
      { error: 'Failed to create calendar event' },
      { status: 500 }
    );
  }
}
