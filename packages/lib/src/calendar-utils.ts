/**
 * Calendar Utility Functions
 * Provides functions for calendar aggregation, event filtering, and tree traversal
 */

import { PageType } from './enums';
import {
  CalendarEvent,
  CalendarContent,
  parseCalendarContent,
  AggregatedEvent,
} from './calendar-types';

export interface PageTreeNode {
  id: string;
  title: string;
  type: PageType;
  content: string;
  parentId: string | null;
  driveId: string;
}

/**
 * Recursively finds all child calendar pages up to a maximum depth
 * @param pages - Array of all pages in the workspace
 * @param parentId - ID of the parent page to start from
 * @param currentDepth - Current recursion depth (internal use)
 * @param maxDepth - Maximum depth to traverse (default: 10)
 * @returns Array of calendar page IDs
 */
export function findChildCalendars(
  pages: PageTreeNode[],
  parentId: string,
  currentDepth: number = 0,
  maxDepth: number = 10
): string[] {
  if (currentDepth >= maxDepth) {
    console.warn(`Maximum calendar aggregation depth of ${maxDepth} reached`);
    return [];
  }

  // Find all direct children of the parent
  const children = pages.filter((page) => page.parentId === parentId);

  // Find calendar pages among direct children
  const calendarChildren = children
    .filter((page) => page.type === PageType.CALENDAR)
    .map((page) => page.id);

  // Recursively find calendar pages in descendants
  const descendantCalendars: string[] = [];
  for (const child of children) {
    const childCalendars = findChildCalendars(
      pages,
      child.id,
      currentDepth + 1,
      maxDepth
    );
    descendantCalendars.push(...childCalendars);
  }

  return [...calendarChildren, ...descendantCalendars];
}

/**
 * Gets events from a single calendar page
 * @param pageContent - The content field from a calendar page
 * @param pageId - ID of the calendar page
 * @param pageTitle - Title of the calendar page
 * @returns Array of aggregated events with source information
 */
export function getEventsFromCalendar(
  pageContent: string,
  pageId: string,
  pageTitle: string
): AggregatedEvent[] {
  const calendarContent = parseCalendarContent(pageContent);

  return calendarContent.events.map((event) => ({
    ...event,
    sourcePageId: pageId,
    sourcePageTitle: pageTitle,
  }));
}

/**
 * Filters events by date range
 * @param events - Array of calendar events
 * @param start - ISO datetime string for range start (optional)
 * @param end - ISO datetime string for range end (optional)
 * @returns Filtered array of events
 */
export function filterEventsByDateRange(
  events: CalendarEvent[],
  start?: string,
  end?: string
): CalendarEvent[] {
  return events.filter((event) => {
    const eventStart = new Date(event.start);
    const eventEnd = new Date(event.end);

    if (start && end) {
      const rangeStart = new Date(start);
      const rangeEnd = new Date(end);
      // Event overlaps with range if it starts before range ends and ends after range starts
      return eventStart < rangeEnd && eventEnd > rangeStart;
    } else if (start) {
      const rangeStart = new Date(start);
      return eventEnd >= rangeStart;
    } else if (end) {
      const rangeEnd = new Date(end);
      return eventStart <= rangeEnd;
    }

    return true; // No date filter
  });
}

/**
 * Sorts events by start date (ascending)
 * @param events - Array of calendar events
 * @returns Sorted array of events
 */
export function sortEventsByStartDate<T extends CalendarEvent>(events: T[]): T[] {
  return [...events].sort((a, b) => {
    const dateA = new Date(a.start).getTime();
    const dateB = new Date(b.start).getTime();
    return dateA - dateB;
  });
}

/**
 * Merges events from multiple calendars and removes duplicates
 * @param eventsArrays - Array of event arrays from different calendars
 * @returns Merged and deduplicated array of events
 */
export function mergeCalendarEvents<T extends CalendarEvent>(
  eventsArrays: T[][]
): T[] {
  const allEvents = eventsArrays.flat();

  // Deduplicate by event ID (in case of cross-calendar references)
  const seenIds = new Set<string>();
  const uniqueEvents = allEvents.filter((event) => {
    if (seenIds.has(event.id)) {
      return false;
    }
    seenIds.add(event.id);
    return true;
  });

  return sortEventsByStartDate(uniqueEvents);
}

/**
 * Checks if a calendar should be excluded based on configuration
 * @param calendarId - ID of the calendar to check
 * @param config - Calendar configuration with exclusion list
 * @returns True if calendar should be excluded
 */
export function isCalendarExcluded(
  calendarId: string,
  excludedCalendars: string[] = []
): boolean {
  return excludedCalendars.includes(calendarId);
}

/**
 * Validates an event object
 * @param event - Event object to validate
 * @returns Object with validation result and error message
 */
export function validateEvent(event: Partial<CalendarEvent>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!event.title || event.title.trim().length === 0) {
    errors.push('Event title is required');
  }

  if (event.title && event.title.length > 200) {
    errors.push('Event title must be 200 characters or less');
  }

  if (!event.start) {
    errors.push('Event start time is required');
  }

  if (!event.end) {
    errors.push('Event end time is required');
  }

  if (event.start && event.end) {
    const startDate = new Date(event.start);
    const endDate = new Date(event.end);

    if (isNaN(startDate.getTime())) {
      errors.push('Invalid start date format');
    }

    if (isNaN(endDate.getTime())) {
      errors.push('Invalid end date format');
    }

    if (startDate >= endDate) {
      errors.push('Event end time must be after start time');
    }
  }

  if (event.description && event.description.length > 5000) {
    errors.push('Event description must be 5000 characters or less');
  }

  if (event.color && !/^#[0-9A-F]{6}$/i.test(event.color)) {
    errors.push('Event color must be a valid hex color code (e.g., #FF5733)');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Generates a unique event ID
 * @returns Unique event ID string
 */
export function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Calculates the depth of a page in the tree
 * @param pages - Array of all pages
 * @param pageId - ID of the page to calculate depth for
 * @param currentDepth - Current depth (internal use)
 * @returns Depth of the page (0 = root level)
 */
export function calculatePageDepth(
  pages: PageTreeNode[],
  pageId: string,
  currentDepth: number = 0
): number {
  const page = pages.find((p) => p.id === pageId);
  if (!page || !page.parentId) {
    return currentDepth;
  }
  return calculatePageDepth(pages, page.parentId, currentDepth + 1);
}

/**
 * Gets all parent calendar pages for a given page
 * @param pages - Array of all pages
 * @param pageId - ID of the page to start from
 * @returns Array of parent calendar page IDs (closest to furthest)
 */
export function getParentCalendars(
  pages: PageTreeNode[],
  pageId: string
): string[] {
  const parentCalendars: string[] = [];
  let currentPage = pages.find((p) => p.id === pageId);

  while (currentPage && currentPage.parentId) {
    const parent = pages.find((p) => p.id === currentPage!.parentId);
    if (!parent) break;

    if (parent.type === PageType.CALENDAR) {
      parentCalendars.push(parent.id);
    }

    currentPage = parent;
  }

  return parentCalendars;
}

/**
 * Filters events by source calendar IDs
 * @param events - Array of aggregated events
 * @param sourcePageIds - Array of page IDs to include
 * @returns Filtered events
 */
export function filterEventsBySource<T extends AggregatedEvent>(
  events: T[],
  sourcePageIds: string[]
): T[] {
  if (sourcePageIds.length === 0) {
    return events;
  }
  return events.filter((event) => sourcePageIds.includes(event.sourcePageId));
}

/**
 * Groups events by source calendar
 * @param events - Array of aggregated events
 * @returns Map of source page ID to events
 */
export function groupEventsBySource<T extends AggregatedEvent>(
  events: T[]
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();

  for (const event of events) {
    const existing = grouped.get(event.sourcePageId) || [];
    existing.push(event);
    grouped.set(event.sourcePageId, existing);
  }

  return grouped;
}
