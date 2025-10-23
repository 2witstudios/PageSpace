import { db, pages, eq, and } from '@pagespace/db';
import { PageType } from '../enums';
import { parseCalendarContent, CalendarEvent, CalendarDoc } from '../calendar';
import { expandRecurringEvent } from '../calendar/recurrence';
import { getUserAccessLevel } from './permissions';

/**
 * Represents an aggregated event with source information
 */
export interface AggregatedEvent extends CalendarEvent {
  sourcePageId: string;
  sourcePageTitle: string;
}

/**
 * Result of calendar aggregation including own events and child events
 */
export interface AggregatedCalendarResult {
  ownEvents: CalendarEvent[];
  aggregatedEvents: {
    sourcePageId: string;
    sourcePageTitle: string;
    events: CalendarEvent[];
  }[];
  flatEvents: AggregatedEvent[];
}

/**
 * Get all calendar events for a user, including aggregated events from child calendars
 * @param userId - The user ID requesting the events
 * @param calendarPageId - The calendar page ID
 * @param startDate - Start of date range (ISO string)
 * @param endDate - End of date range (ISO string)
 * @returns Aggregated calendar events
 */
export async function getAggregatedEvents(
  userId: string,
  calendarPageId: string,
  startDate?: string,
  endDate?: string
): Promise<AggregatedCalendarResult> {
  // Fetch the calendar page
  const calendarPage = await db.query.pages.findFirst({
    where: and(
      eq(pages.id, calendarPageId),
      eq(pages.isTrashed, false)
    ),
  });

  if (!calendarPage || calendarPage.type !== PageType.CALENDAR) {
    throw new Error('Calendar page not found or invalid type');
  }

  // Check user has permission to view this calendar
  const accessLevel = await getUserAccessLevel(userId, calendarPageId);
  if (!accessLevel || accessLevel === 'NONE') {
    throw new Error('User does not have permission to view this calendar');
  }

  // Parse the calendar content
  const calendar = parseCalendarContent(calendarPage.content);

  // Get own events and expand recurring events
  let ownEvents = calendar.events;
  if (startDate && endDate) {
    ownEvents = expandEventsInRange(calendar.events, startDate, endDate);
  }

  // Initialize result
  const result: AggregatedCalendarResult = {
    ownEvents,
    aggregatedEvents: [],
    flatEvents: ownEvents.map(event => ({
      ...event,
      sourcePageId: calendarPageId,
      sourcePageTitle: calendarPage.title,
    })),
  };

  // Check if aggregation is enabled
  if (!calendar.config.aggregate_children) {
    return result;
  }

  // Find all child calendar pages
  const childCalendars = await findChildCalendars(
    calendarPageId,
    calendarPage.driveId,
    userId
  );

  // Process each child calendar
  for (const childCalendar of childCalendars) {
    // Skip if excluded
    if (calendar.config.excluded_calendars?.includes(childCalendar.id)) {
      continue;
    }

    // Parse child calendar content
    const childCalendarDoc = parseCalendarContent(childCalendar.content);
    let childEvents = childCalendarDoc.events;

    // Expand recurring events in range
    if (startDate && endDate) {
      childEvents = expandEventsInRange(childEvents, startDate, endDate);
    }

    // Add to aggregated events
    result.aggregatedEvents.push({
      sourcePageId: childCalendar.id,
      sourcePageTitle: childCalendar.title,
      events: childEvents,
    });

    // Add to flat events
    result.flatEvents.push(
      ...childEvents.map(event => ({
        ...event,
        sourcePageId: childCalendar.id,
        sourcePageTitle: childCalendar.title,
      }))
    );
  }

  // Sort flat events by start date
  result.flatEvents.sort((a, b) =>
    new Date(a.start).getTime() - new Date(b.start).getTime()
  );

  return result;
}

/**
 * Get personal calendar events for a user across multiple calendars
 * @param userId - The user ID
 * @param includedCalendarIds - Array of calendar page IDs to include
 * @param startDate - Start of date range (ISO string)
 * @param endDate - End of date range (ISO string)
 * @returns Aggregated events from all included calendars
 */
export async function getPersonalCalendarEvents(
  userId: string,
  includedCalendarIds: string[],
  startDate?: string,
  endDate?: string
): Promise<AggregatedCalendarResult> {
  const result: AggregatedCalendarResult = {
    ownEvents: [],
    aggregatedEvents: [],
    flatEvents: [],
  };

  // Process each included calendar
  for (const calendarId of includedCalendarIds) {
    try {
      // Fetch calendar page
      const calendarPage = await db.query.pages.findFirst({
        where: and(
          eq(pages.id, calendarId),
          eq(pages.isTrashed, false)
        ),
      });

      if (!calendarPage || calendarPage.type !== PageType.CALENDAR) {
        continue; // Skip invalid calendars
      }

      // Check permission
      const accessLevel = await getUserAccessLevel(userId, calendarId);
      if (!accessLevel || accessLevel === 'NONE') {
        continue; // Skip calendars user can't access
      }

      // Parse calendar content
      const calendar = parseCalendarContent(calendarPage.content);
      let calendarEvents = calendar.events;

      // Expand recurring events in range
      if (startDate && endDate) {
        calendarEvents = expandEventsInRange(calendarEvents, startDate, endDate);
      }

      // Add to aggregated events
      result.aggregatedEvents.push({
        sourcePageId: calendarPage.id,
        sourcePageTitle: calendarPage.title,
        events: calendarEvents,
      });

      // Add to flat events
      result.flatEvents.push(
        ...calendarEvents.map(event => ({
          ...event,
          sourcePageId: calendarPage.id,
          sourcePageTitle: calendarPage.title,
        }))
      );
    } catch (error) {
      console.error(`Error loading calendar ${calendarId}:`, error);
      // Continue processing other calendars
    }
  }

  // Sort flat events by start date
  result.flatEvents.sort((a, b) =>
    new Date(a.start).getTime() - new Date(b.start).getTime()
  );

  return result;
}

/**
 * Recursively find all child calendar pages that the user has access to
 * @param parentPageId - The parent page ID to start from
 * @param driveId - The drive ID to search within
 * @param userId - The user ID for permission checking
 * @param maxDepth - Maximum recursion depth (default 10)
 * @returns Array of accessible child calendar pages
 */
async function findChildCalendars(
  parentPageId: string,
  driveId: string,
  userId: string,
  maxDepth: number = 10,
  currentDepth: number = 0
): Promise<Array<{ id: string; title: string; content: string }>> {
  if (currentDepth >= maxDepth) {
    return []; // Prevent infinite recursion
  }

  const results: Array<{ id: string; title: string; content: string }> = [];

  // Find direct children
  const children = await db.query.pages.findMany({
    where: and(
      eq(pages.parentId, parentPageId),
      eq(pages.driveId, driveId),
      eq(pages.isTrashed, false)
    ),
    columns: {
      id: true,
      title: true,
      type: true,
      content: true,
      parentId: true,
    },
  });

  for (const child of children) {
    // If it's a calendar, check permission and add it
    if (child.type === PageType.CALENDAR) {
      const accessLevel = await getUserAccessLevel(userId, child.id);
      if (accessLevel && accessLevel !== 'NONE') {
        results.push({
          id: child.id,
          title: child.title,
          content: child.content,
        });
      }
    }

    // Recursively search children (whether they're calendars or folders)
    const grandchildren = await findChildCalendars(
      child.id,
      driveId,
      userId,
      maxDepth,
      currentDepth + 1
    );
    results.push(...grandchildren);
  }

  return results;
}

/**
 * Expand all events in a date range, handling recurring events
 * @param events - Array of calendar events
 * @param startDate - Start of date range (ISO string)
 * @param endDate - End of date range (ISO string)
 * @returns Array of expanded events
 */
function expandEventsInRange(
  events: CalendarEvent[],
  startDate: string,
  endDate: string
): CalendarEvent[] {
  const expandedEvents: CalendarEvent[] = [];

  for (const event of events) {
    if (event.recurrence) {
      // Expand recurring event
      const instances = expandRecurringEvent(event, startDate, endDate);
      expandedEvents.push(...instances);
    } else {
      // Check if non-recurring event is in range
      const eventStart = new Date(event.start);
      const eventEnd = new Date(event.end);
      const rangeStart = new Date(startDate);
      const rangeEnd = new Date(endDate);

      // Include event if it overlaps with the range
      if (eventStart <= rangeEnd && eventEnd >= rangeStart) {
        expandedEvents.push(event);
      }
    }
  }

  return expandedEvents;
}

/**
 * Get all accessible calendars for a user across all drives
 * @param userId - The user ID
 * @returns Array of calendar pages the user can access
 */
export async function getUserAccessibleCalendars(
  userId: string
): Promise<Array<{ id: string; title: string; driveId: string; driveName: string }>> {
  // This would need to query all drives the user has access to
  // and find all CALENDAR pages within those drives
  // For now, returning a placeholder - full implementation would require
  // joining with drive_members table to find accessible drives

  const calendars = await db.query.pages.findMany({
    where: and(
      eq(pages.type, PageType.CALENDAR),
      eq(pages.isTrashed, false)
    ),
    columns: {
      id: true,
      title: true,
      driveId: true,
    },
  });

  // Filter by permission (this is a simplified version)
  const accessibleCalendars = [];
  for (const calendar of calendars) {
    const accessLevel = await getUserAccessLevel(userId, calendar.id);
    if (accessLevel && accessLevel !== 'NONE') {
      // Fetch drive name
      const drive = await db.query.drives.findFirst({
        where: eq(pages.driveId, calendar.driveId),
        columns: { name: true },
      });

      accessibleCalendars.push({
        id: calendar.id,
        title: calendar.title,
        driveId: calendar.driveId,
        driveName: drive?.name || 'Unknown Drive',
      });
    }
  }

  return accessibleCalendars;
}
