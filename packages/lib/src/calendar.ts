import { parse as parseToml } from '@iarna/toml';

import { PageType } from './enums';

export const CALENDAR_VERSION = 1;
export const CALENDARDOC_MAGIC = '#%PAGESPACE_CALENDAR';
export const CALENDARDOC_VERSION = 'v1';

// Recurrence rule interface (RFC 5545 compliant)
export interface RecurrenceRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  until?: string; // ISO 8601 date string
  count?: number;
  by_weekday?: string[]; // e.g., ['MO', 'WE', 'FR']
  by_monthday?: number[]; // e.g., [1, 15]
}

// Calendar event interface
export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  start: string; // ISO 8601 datetime
  end: string; // ISO 8601 datetime
  all_day: boolean;
  color?: string; // Hex color code
  attendees?: string[]; // Array of user IDs
  recurrence?: RecurrenceRule;
  created_at: string; // ISO 8601 datetime
  created_by: string; // User ID
  updated_at: string; // ISO 8601 datetime
}

// Calendar configuration interface
export interface CalendarConfig {
  aggregate_children: boolean;
  included_calendars?: string[]; // Page IDs
  excluded_calendars?: string[]; // Page IDs
}

// Calendar document interface (TOML structure)
export interface CalendarDoc {
  version: typeof CALENDARDOC_VERSION;
  page_id?: string;
  config: CalendarConfig;
  events: CalendarEvent[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toSnakeCase(value: string): string {
  return value.replace(/([A-Z])/g, '_$1').toLowerCase();
}

function toCamelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
}

function formatTomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function formatTomlValue(value: unknown): string {
  if (value === null || value === undefined) {
    return formatTomlString('');
  }
  if (typeof value === 'string') {
    return formatTomlString(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '0';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => formatTomlValue(item));
    return `[${parts.join(', ')}]`;
  }
  if (isObject(value)) {
    return formatInlineTable(value as Record<string, unknown>);
  }
  return formatTomlString(String(value));
}

function formatInlineTable(record: Record<string, unknown>): string {
  const entries = Object.entries(record).filter(([, entryValue]) => entryValue !== undefined);
  const parts = entries.map(([key, entryValue]) => `${toSnakeCase(key)} = ${formatTomlValue(entryValue)}`);
  if (parts.length === 0) {
    return '{}';
  }
  return `{ ${parts.join(', ')} }`;
}

// Create an empty calendar document
export function createEmptyCalendar(): CalendarDoc {
  return {
    version: CALENDARDOC_VERSION,
    config: {
      aggregate_children: true,
    },
    events: [],
  };
}

// Check if a string is a CalendarDoc TOML string
export function isCalendarDocString(value: string): boolean {
  return value.trimStart().startsWith(CALENDARDOC_MAGIC);
}

// Parse CalendarDoc from TOML string
export function parseCalendarDocString(value: string): CalendarDoc {
  const lines = value.split(/\r?\n/);
  let headerIndex = -1;

  // Find the header line
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim()) {
      headerIndex = index;
      break;
    }
  }

  if (headerIndex === -1) {
    throw new Error('Missing CalendarDoc header');
  }

  const headerLine = lines[headerIndex].trim();

  if (!headerLine.startsWith(CALENDARDOC_MAGIC)) {
    throw new Error('Invalid CalendarDoc header');
  }

  const versionPart = headerLine.slice(CALENDARDOC_MAGIC.length).trim();
  if (versionPart && versionPart !== CALENDARDOC_VERSION) {
    throw new Error(`Unsupported CalendarDoc version: ${versionPart}`);
  }

  const tomlSource = lines.slice(headerIndex + 1).join('\n');
  const parsed = tomlSource.trim() ? (parseToml(tomlSource) as Record<string, unknown>) : {};
  return normalizeCalendarDocObject(parsed);
}

// Normalize a parsed TOML object to CalendarDoc
function normalizeCalendarDocObject(value: Record<string, unknown>): CalendarDoc {
  const pageId = typeof value.page_id === 'string' ? value.page_id : undefined;

  // Parse config
  const configSource = isObject(value.config) ? value.config : {};
  const config: CalendarConfig = {
    aggregate_children: typeof configSource.aggregate_children === 'boolean'
      ? configSource.aggregate_children
      : true,
  };

  if (Array.isArray(configSource.included_calendars)) {
    config.included_calendars = configSource.included_calendars.filter(
      (id): id is string => typeof id === 'string'
    );
  }

  if (Array.isArray(configSource.excluded_calendars)) {
    config.excluded_calendars = configSource.excluded_calendars.filter(
      (id): id is string => typeof id === 'string'
    );
  }

  // Parse events
  const eventsInput = Array.isArray(value.events) ? value.events : [];
  const events: CalendarEvent[] = [];

  eventsInput.forEach((eventValue) => {
    if (!isObject(eventValue)) {
      return;
    }

    const id = typeof eventValue.id === 'string' ? eventValue.id : '';
    const title = typeof eventValue.title === 'string' ? eventValue.title : '';
    const start = typeof eventValue.start === 'string' ? eventValue.start : '';
    const end = typeof eventValue.end === 'string' ? eventValue.end : '';

    if (!id || !title || !start || !end) {
      return; // Skip invalid events
    }

    const event: CalendarEvent = {
      id,
      title,
      start,
      end,
      all_day: typeof eventValue.all_day === 'boolean' ? eventValue.all_day : false,
      created_at: typeof eventValue.created_at === 'string' ? eventValue.created_at : new Date().toISOString(),
      created_by: typeof eventValue.created_by === 'string' ? eventValue.created_by : '',
      updated_at: typeof eventValue.updated_at === 'string' ? eventValue.updated_at : new Date().toISOString(),
    };

    if (typeof eventValue.description === 'string') {
      event.description = eventValue.description;
    }

    if (typeof eventValue.color === 'string') {
      event.color = eventValue.color;
    }

    if (Array.isArray(eventValue.attendees)) {
      event.attendees = eventValue.attendees.filter((a): a is string => typeof a === 'string');
    }

    // Parse recurrence rule
    if (isObject(eventValue.recurrence)) {
      const rec = eventValue.recurrence;
      const freq = typeof rec.freq === 'string' ? rec.freq : undefined;
      const interval = typeof rec.interval === 'number' ? rec.interval : 1;

      if (freq && ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) {
        const recurrence: RecurrenceRule = {
          freq: freq as RecurrenceRule['freq'],
          interval,
        };

        if (typeof rec.until === 'string') {
          recurrence.until = rec.until;
        }

        if (typeof rec.count === 'number') {
          recurrence.count = rec.count;
        }

        if (Array.isArray(rec.by_weekday)) {
          recurrence.by_weekday = rec.by_weekday.filter((d): d is string => typeof d === 'string');
        }

        if (Array.isArray(rec.by_monthday)) {
          recurrence.by_monthday = rec.by_monthday.filter((d): d is number => typeof d === 'number');
        }

        event.recurrence = recurrence;
      }
    }

    events.push(event);
  });

  return {
    version: CALENDARDOC_VERSION,
    page_id: pageId,
    config,
    events,
  };
}

// Parse calendar content from various formats
export function parseCalendarContent(content: unknown): CalendarDoc {
  if (!content) {
    return createEmptyCalendar();
  }

  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (!trimmed) {
      return createEmptyCalendar();
    }

    if (isCalendarDocString(trimmed)) {
      try {
        return parseCalendarDocString(trimmed);
      } catch {
        return createEmptyCalendar();
      }
    }

    // Try parsing as JSON (legacy format)
    try {
      const parsed = JSON.parse(trimmed);
      return parseCalendarContent(parsed);
    } catch {
      return createEmptyCalendar();
    }
  }

  // Handle object format (e.g., from JSON)
  if (isObject(content)) {
    try {
      return normalizeCalendarDocObject(content);
    } catch {
      return createEmptyCalendar();
    }
  }

  return createEmptyCalendar();
}

// Serialize CalendarDoc to TOML string
export function stringifyCalendarDoc(doc: CalendarDoc): string {
  const lines: string[] = [`${CALENDARDOC_MAGIC} ${CALENDARDOC_VERSION}`];

  if (doc.page_id) {
    lines.push(`page_id = ${formatTomlString(doc.page_id)}`);
  }

  // Add config section
  lines.push('');
  lines.push('[config]');
  lines.push(`aggregate_children = ${doc.config.aggregate_children}`);

  if (doc.config.included_calendars && doc.config.included_calendars.length > 0) {
    lines.push(`included_calendars = ${formatTomlValue(doc.config.included_calendars)}`);
  }

  if (doc.config.excluded_calendars && doc.config.excluded_calendars.length > 0) {
    lines.push(`excluded_calendars = ${formatTomlValue(doc.config.excluded_calendars)}`);
  }

  // Add events
  for (const event of doc.events) {
    lines.push('');
    lines.push('[[events]]');
    lines.push(`id = ${formatTomlString(event.id)}`);
    lines.push(`title = ${formatTomlString(event.title)}`);

    if (event.description) {
      lines.push(`description = ${formatTomlString(event.description)}`);
    }

    lines.push(`start = ${formatTomlString(event.start)}`);
    lines.push(`end = ${formatTomlString(event.end)}`);
    lines.push(`all_day = ${event.all_day}`);

    if (event.color) {
      lines.push(`color = ${formatTomlString(event.color)}`);
    }

    if (event.attendees && event.attendees.length > 0) {
      lines.push(`attendees = ${formatTomlValue(event.attendees)}`);
    }

    lines.push(`created_at = ${formatTomlString(event.created_at)}`);
    lines.push(`created_by = ${formatTomlString(event.created_by)}`);
    lines.push(`updated_at = ${formatTomlString(event.updated_at)}`);

    // Add recurrence rule if present
    if (event.recurrence) {
      lines.push('');
      lines.push('[events.recurrence]');
      lines.push(`freq = ${formatTomlString(event.recurrence.freq)}`);
      lines.push(`interval = ${event.recurrence.interval}`);

      if (event.recurrence.until) {
        lines.push(`until = ${formatTomlString(event.recurrence.until)}`);
      }

      if (event.recurrence.count !== undefined) {
        lines.push(`count = ${event.recurrence.count}`);
      }

      if (event.recurrence.by_weekday && event.recurrence.by_weekday.length > 0) {
        lines.push(`by_weekday = ${formatTomlValue(event.recurrence.by_weekday)}`);
      }

      if (event.recurrence.by_monthday && event.recurrence.by_monthday.length > 0) {
        lines.push(`by_monthday = ${formatTomlValue(event.recurrence.by_monthday)}`);
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

// Serialize CalendarDoc to TOML string (convenience wrapper)
export function serializeCalendarContent(calendar: CalendarDoc, options: { pageId?: string } = {}): string {
  const doc: CalendarDoc = {
    ...calendar,
    page_id: options.pageId || calendar.page_id,
  };
  return stringifyCalendarDoc(doc);
}

// Check if a page type is CALENDAR
export function isCalendarType(type: PageType): boolean {
  return type === PageType.CALENDAR;
}
