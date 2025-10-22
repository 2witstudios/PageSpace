/**
 * Calendar Types for PageSpace
 * Defines the structure for calendar events, recurrence rules, and calendar configuration
 */

/**
 * Recurrence frequency options
 */
export enum RecurrenceFrequency {
  DAILY = 'DAILY',
  WEEKLY = 'WEEKLY',
  MONTHLY = 'MONTHLY',
  YEARLY = 'YEARLY',
}

/**
 * Recurrence rule for repeating events
 */
export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  interval: number; // e.g., 1 for every week, 2 for every 2 weeks
  endDate?: string; // ISO datetime
  count?: number; // Alternative to endDate: number of occurrences
  byWeekDay?: number[]; // For weekly: [0-6] where 0 is Sunday
  byMonthDay?: number; // For monthly: day of month [1-31]
}

/**
 * Calendar event structure
 */
export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  start: string; // ISO datetime with timezone
  end: string; // ISO datetime with timezone
  allDay: boolean;
  color?: string; // Hex color code for visual coding
  attendees?: string[]; // Array of user IDs
  recurrence?: RecurrenceRule;
  sourcePageId: string; // Which calendar created this event
  createdBy: string; // User ID
  createdAt: string; // ISO datetime
  updatedAt: string; // ISO datetime
}

/**
 * Calendar configuration stored in page content
 */
export interface CalendarConfiguration {
  aggregateChildren: boolean; // Whether to show events from child calendars
  manuallyIncludedCalendars?: string[]; // Page IDs of calendars to include
  excludedCalendars?: string[]; // Page IDs of calendars to exclude
  showInPersonalCalendar?: boolean; // Whether this calendar appears in personal calendar
}

/**
 * Calendar content structure (stored in page.content field)
 */
export interface CalendarContent {
  events: CalendarEvent[];
  config: CalendarConfiguration;
}

/**
 * Aggregated event with source information
 */
export interface AggregatedEvent extends CalendarEvent {
  sourcePageTitle: string;
  sourcePageId: string;
}

/**
 * Response structure for calendar events API
 */
export interface CalendarEventsResponse {
  ownEvents: CalendarEvent[];
  aggregatedEvents: {
    sourcePageId: string;
    sourcePageTitle: string;
    events: CalendarEvent[];
  }[];
  flatEvents: AggregatedEvent[];
}

/**
 * Request body for creating/updating an event
 */
export interface EventCreateRequest {
  title: string;
  description?: string;
  start: string;
  end: string;
  allDay?: boolean;
  color?: string;
  attendees?: string[];
  recurrence?: RecurrenceRule;
}

/**
 * Default calendar configuration
 */
export const DEFAULT_CALENDAR_CONFIG: CalendarConfiguration = {
  aggregateChildren: true,
  manuallyIncludedCalendars: [],
  excludedCalendars: [],
  showInPersonalCalendar: false,
};

/**
 * Default calendar content for new calendars
 */
export const DEFAULT_CALENDAR_CONTENT: CalendarContent = {
  events: [],
  config: DEFAULT_CALENDAR_CONFIG,
};

/**
 * Helper to create an empty calendar content structure
 */
export function createEmptyCalendar(): CalendarContent {
  return {
    events: [],
    config: { ...DEFAULT_CALENDAR_CONFIG },
  };
}

/**
 * Helper to parse calendar content from page content field
 */
export function parseCalendarContent(content: string): CalendarContent {
  try {
    const parsed = JSON.parse(content || '{}');
    return {
      events: parsed.events || [],
      config: { ...DEFAULT_CALENDAR_CONFIG, ...(parsed.config || {}) },
    };
  } catch (error) {
    console.error('Failed to parse calendar content:', error);
    return createEmptyCalendar();
  }
}

/**
 * Helper to serialize calendar content for storage
 */
export function serializeCalendarContent(content: CalendarContent): string {
  return JSON.stringify(content);
}

/**
 * Type guard to check if content is valid calendar content
 */
export function isValidCalendarContent(content: any): content is CalendarContent {
  return (
    content &&
    typeof content === 'object' &&
    Array.isArray(content.events) &&
    content.config &&
    typeof content.config === 'object'
  );
}
