import { NextResponse } from 'next/server';
import { pages, db, eq, inArray } from '@pagespace/db';
import { canUserViewPage } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { PageType } from '@pagespace/lib/enums';
import {
  parseCalendarContent,
  CalendarEventsResponse,
  AggregatedEvent,
} from '@pagespace/lib/calendar-types';
import {
  findChildCalendars,
  getEventsFromCalendar,
  filterEventsByDateRange,
  sortEventsByStartDate,
  isCalendarExcluded,
  mergeCalendarEvents,
} from '@pagespace/lib/calendar-utils';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: false };

/**
 * GET /api/pages/[pageId]/calendar-events
 * Fetches events from a calendar page, optionally including aggregated events from child calendars
 *
 * Query parameters:
 * - start: ISO datetime for range start (optional)
 * - end: ISO datetime for range end (optional)
 * - includeAggregated: boolean, default true
 */
export async function GET(
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

    // Check if user has VIEW permission on the calendar page
    const canView = await canUserViewPage(user.id, pageId);
    if (!canView) {
      return NextResponse.json(
        { error: 'You do not have permission to view this calendar' },
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

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const start = searchParams.get('start') || undefined;
    const end = searchParams.get('end') || undefined;
    const includeAggregated = searchParams.get('includeAggregated') !== 'false';

    // Parse calendar content
    const calendarContent = parseCalendarContent(calendarPage.content);

    // Get own events
    let ownEvents = calendarContent.events;
    if (start || end) {
      ownEvents = filterEventsByDateRange(ownEvents, start, end);
    }

    // Initialize response
    const response: CalendarEventsResponse = {
      ownEvents: sortEventsByStartDate(ownEvents),
      aggregatedEvents: [],
      flatEvents: ownEvents.map(event => ({
        ...event,
        sourcePageId: pageId,
        sourcePageTitle: calendarPage.title,
      })),
    };

    // If aggregation is disabled or not requested, return early
    if (!includeAggregated || !calendarContent.config.aggregateChildren) {
      return NextResponse.json(response);
    }

    // Find all descendant pages in the same drive
    const allPages = await db
      .select({
        id: pages.id,
        title: pages.title,
        type: pages.type,
        content: pages.content,
        parentId: pages.parentId,
        driveId: pages.driveId,
      })
      .from(pages)
      .where(eq(pages.driveId, calendarPage.driveId));

    // Find child calendar pages
    const childCalendarIds = findChildCalendars(
      allPages.map(p => ({
        id: p.id,
        title: p.title,
        type: p.type as PageType,
        content: p.content,
        parentId: p.parentId,
        driveId: p.driveId,
      })),
      pageId
    );

    // Filter out excluded calendars
    const excludedCalendars = calendarContent.config.excludedCalendars || [];
    const filteredChildCalendarIds = childCalendarIds.filter(
      id => !isCalendarExcluded(id, excludedCalendars)
    );

    // Add manually included calendars (if any)
    const manuallyIncluded = calendarContent.config.manuallyIncludedCalendars || [];
    const allIncludedCalendarIds = [...new Set([...filteredChildCalendarIds, ...manuallyIncluded])];

    if (allIncludedCalendarIds.length === 0) {
      return NextResponse.json(response);
    }

    // Fetch all child calendar pages
    const childCalendarPages = await db
      .select({
        id: pages.id,
        title: pages.title,
        content: pages.content,
      })
      .from(pages)
      .where(inArray(pages.id, allIncludedCalendarIds));

    // Process each child calendar
    for (const childCalendar of childCalendarPages) {
      // Check if user has permission to view this child calendar
      const canViewChild = await canUserViewPage(user.id, childCalendar.id);
      if (!canViewChild) {
        continue; // Skip calendars user doesn't have permission to view
      }

      // Get events from this calendar
      let childEvents = getEventsFromCalendar(
        childCalendar.content,
        childCalendar.id,
        childCalendar.title
      );

      // Apply date range filter
      if (start || end) {
        childEvents = filterEventsByDateRange(childEvents, start, end);
      }

      // Add to aggregated events
      response.aggregatedEvents.push({
        sourcePageId: childCalendar.id,
        sourcePageTitle: childCalendar.title,
        events: sortEventsByStartDate(childEvents),
      });
    }

    // Merge all events into flat list
    const allEventsArrays: AggregatedEvent[][] = [
      response.flatEvents,
      ...response.aggregatedEvents.map(a => a.events),
    ];
    response.flatEvents = mergeCalendarEvents(allEventsArrays);

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error fetching calendar events:', error);
    return NextResponse.json(
      { error: 'Failed to fetch calendar events' },
      { status: 500 }
    );
  }
}
