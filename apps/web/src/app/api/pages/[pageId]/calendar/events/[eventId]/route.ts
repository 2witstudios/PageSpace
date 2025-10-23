import { NextResponse } from 'next/server';
import { db, pages, eq, and } from '@pagespace/db';
import { authenticateRequestWithOptions, AUTH_OPTIONS } from '@/lib/auth-utils';
import { canUserEditPage, canUserDeletePage } from '@pagespace/lib/server';
import { PageType } from '@pagespace/lib/enums';
import {
  parseCalendarContent,
  serializeCalendarContent,
  CalendarDoc,
} from '@pagespace/lib/calendar';
import { validateRecurrenceRule } from '@pagespace/lib/calendar/recurrence';
import { calendarCache } from '@pagespace/lib/services/calendar-cache';
import { z } from 'zod';

// Validation schema for updating events (all fields optional)
const eventUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
  allDay: z.boolean().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  attendees: z.array(z.string()).optional(),
  recurrence: z.object({
    freq: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
    interval: z.number().int().min(1),
    until: z.string().datetime().optional(),
    count: z.number().int().min(1).optional(),
    by_weekday: z.array(z.string()).optional(),
    by_monthday: z.array(z.number().int().min(1).max(31)).optional(),
  }).optional().nullable(), // Allow null to remove recurrence
});

/**
 * GET /api/pages/[pageId]/calendar/events/[eventId]
 * Get a single event by ID
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ pageId: string; eventId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (!auth.isAuthenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // CRITICAL: Await params in Next.js 15
    const { pageId, eventId } = await context.params;

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

    // Parse calendar content
    const calendar: CalendarDoc = parseCalendarContent(calendarPage.content);

    // Find the event
    const event = calendar.events.find(e => e.id === eventId);
    if (!event) {
      return NextResponse.json(
        { error: 'Event not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ event });
  } catch (error) {
    console.error('Error fetching calendar event:', error);
    return NextResponse.json(
      { error: 'Failed to fetch calendar event' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/pages/[pageId]/calendar/events/[eventId]
 * Update an existing event
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ pageId: string; eventId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (!auth.isAuthenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // CRITICAL: Await params in Next.js 15
    const { pageId, eventId } = await context.params;

    // Parse request body
    const body = await request.json();

    // Validate input
    const validationResult = eventUpdateSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        { error: 'Invalid event data', details: validationResult.error.errors },
        { status: 400 }
      );
    }

    const updates = validationResult.data;

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

    // Find the event
    const eventIndex = calendar.events.findIndex(e => e.id === eventId);
    if (eventIndex === -1) {
      return NextResponse.json(
        { error: 'Event not found' },
        { status: 404 }
      );
    }

    const existingEvent = calendar.events[eventIndex];

    // Apply updates
    const updatedEvent = {
      ...existingEvent,
      ...updates,
      updated_at: new Date().toISOString(),
    };

    // Validate date range if both dates are being updated
    const startDate = new Date(updatedEvent.start);
    const endDate = new Date(updatedEvent.end);
    if (endDate <= startDate) {
      return NextResponse.json(
        { error: 'End date must be after start date' },
        { status: 400 }
      );
    }

    // Validate recurrence rule if provided
    if (updatedEvent.recurrence) {
      const recurrenceValidation = validateRecurrenceRule(updatedEvent.recurrence);
      if (!recurrenceValidation.valid) {
        return NextResponse.json(
          { error: recurrenceValidation.error },
          { status: 400 }
        );
      }
    }

    // Update the event
    calendar.events[eventIndex] = updatedEvent;

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
    //   eventId: updatedEvent.id,
    //   operation: 'event_updated',
    //   driveId: calendarPage.driveId,
    //   title: updatedEvent.title,
    //   socketId: request.headers.get('X-Socket-ID') || undefined
    // });

    return NextResponse.json({
      success: true,
      event: updatedEvent,
      message: 'Event updated successfully',
    });
  } catch (error) {
    console.error('Error updating calendar event:', error);
    return NextResponse.json(
      { error: 'Failed to update calendar event' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/pages/[pageId]/calendar/events/[eventId]
 * Delete an event
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ pageId: string; eventId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (!auth.isAuthenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // CRITICAL: Await params in Next.js 15
    const { pageId, eventId } = await context.params;

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

    // Check edit permission (delete events requires edit, not delete page permission)
    const canEdit = await canUserEditPage(auth.userId, pageId);
    if (!canEdit) {
      return NextResponse.json(
        { error: 'Insufficient permissions to edit this calendar' },
        { status: 403 }
      );
    }

    // Parse calendar content
    const calendar: CalendarDoc = parseCalendarContent(calendarPage.content);

    // Find the event
    const eventIndex = calendar.events.findIndex(e => e.id === eventId);
    if (eventIndex === -1) {
      return NextResponse.json(
        { error: 'Event not found' },
        { status: 404 }
      );
    }

    // Remove the event
    const deletedEvent = calendar.events[eventIndex];
    calendar.events.splice(eventIndex, 1);

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
    //   eventId: deletedEvent.id,
    //   operation: 'event_deleted',
    //   driveId: calendarPage.driveId,
    //   title: deletedEvent.title,
    //   socketId: request.headers.get('X-Socket-ID') || undefined
    // });

    return NextResponse.json({
      success: true,
      message: 'Event deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting calendar event:', error);
    return NextResponse.json(
      { error: 'Failed to delete calendar event' },
      { status: 500 }
    );
  }
}
