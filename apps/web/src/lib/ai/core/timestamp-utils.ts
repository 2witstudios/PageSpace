/**
 * Timestamp utilities for AI system prompts
 * Provides current date/time context to AI models for temporal awareness
 */

import * as chrono from 'chrono-node';
import { TIMESTAMP_BUCKET_MS } from './ai-providers-config';

const DEFAULT_TIMEZONE = 'UTC';

/**
 * Floor an epoch-millisecond instant down to a fixed bucket size. Pure and
 * timezone-independent: because every IANA UTC offset is a whole multiple of
 * 5 minutes, flooring the absolute instant to a 5-minute bucket also lands on a
 * 5-minute wall-clock boundary in any timezone.
 */
export function floorToBucket(epochMs: number, bucketMs: number): number {
  return epochMs - (epochMs % bucketMs);
}

export type TimeOfDay = 'morning' | 'afternoon' | 'evening';

/**
 * Validate IANA timezone strings used by Intl APIs.
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/**
 * Normalize timezone input to a safe, valid IANA timezone.
 */
export function normalizeTimezone(timezone?: string | null): string {
  if (!timezone) return DEFAULT_TIMEZONE;
  const trimmedTimezone = timezone.trim();
  if (!trimmedTimezone) return DEFAULT_TIMEZONE;
  return isValidTimezone(trimmedTimezone) ? trimmedTimezone : DEFAULT_TIMEZONE;
}

/**
 * Get the UTC offset in minutes for an IANA timezone at a given date.
 * Positive = east of UTC, negative = west (e.g., America/New_York in winter = -300).
 * Used by chrono-node for timezone-aware natural language date parsing.
 */
export function getTimezoneOffsetMinutes(timezone: string, date?: Date): number {
  const tz = normalizeTimezone(timezone);
  const refDate = date ?? new Date();
  return getTimezoneOffsetMilliseconds(refDate, tz) / (60 * 1000);
}

/**
 * Format a UTC Date for display in a specific timezone.
 */
export function formatDateInTimezone(date: Date, timezone?: string | null): string {
  const tz = normalizeTimezone(timezone);
  return date.toLocaleString('en-US', {
    timeZone: tz,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function getTimezoneOffsetMilliseconds(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  });
  const parts = formatter.formatToParts(date);
  const timezoneOffset = parts.find(part => part.type === 'timeZoneName')?.value;

  if (!timezoneOffset || timezoneOffset === 'GMT') return 0;

  const offsetMatch = timezoneOffset.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!offsetMatch) return 0;

  const sign = offsetMatch[1] === '+' ? 1 : -1;
  const hours = parseInt(offsetMatch[2], 10);
  const minutes = parseInt(offsetMatch[3], 10);

  return sign * (hours * 60 + minutes) * 60 * 1000;
}

/**
 * Check if a string is a naive ISO datetime (has date and time but no timezone indicator).
 * Matches: "2026-02-19T19:00:00", "2026-02-19T19:00", "2026-02-19T19:00:00.000"
 * Does NOT match: "2026-02-19T19:00:00Z", "2026-02-19T19:00:00+05:00", "2026-02-19", "tomorrow"
 */
export function isNaiveISODatetime(input: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(input.trim());
}

/**
 * Interpret a naive ISO datetime string as being in the specified IANA timezone.
 * When a naive datetime like "2026-02-19T19:00:00" is paired with "America/Chicago",
 * this returns a UTC Date representing 7pm Central (= 1am UTC next day),
 * instead of treating 19:00 as UTC.
 */
export function parseNaiveDatetimeInTimezone(naiveDatetime: string, timezone: string): Date {
  // Append 'Z' to force UTC interpretation of the date components
  const asUtc = new Date(naiveDatetime.trim() + 'Z');
  if (isNaN(asUtc.getTime())) {
    throw new Error(`Invalid datetime: "${naiveDatetime}"`);
  }
  const tz = normalizeTimezone(timezone);

  // Two-pass offset resolution keeps results stable across DST boundaries.
  // The offset at the provisional UTC instant may differ from the offset at
  // the actual target instant when a DST transition falls between them.
  const firstOffsetMs = getTimezoneOffsetMilliseconds(asUtc, tz);
  const firstGuess = new Date(asUtc.getTime() - firstOffsetMs);

  const secondOffsetMs = getTimezoneOffsetMilliseconds(firstGuess, tz);
  if (secondOffsetMs !== firstOffsetMs) {
    return new Date(asUtc.getTime() - secondOffsetMs);
  }

  return firstGuess;
}

/**
 * Get user's time-of-day based on their timezone
 * @param timezone - IANA timezone string (e.g., "America/New_York")
 * @param now - Instant (epoch ms) to evaluate; defaults to the current clock.
 *              Injected so the whole prompt can derive from a single instant
 *              and so the function is testable without mocking the global clock.
 * @returns Object with hour and timeOfDay string
 */
export function getUserTimeOfDay(
  timezone?: string | null,
  now: number = Date.now(),
): { hour: number; timeOfDay: TimeOfDay } {
  const tz = normalizeTimezone(timezone);

  // Get the hour in the user's timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
  });

  // `% 24` guards the midnight edge: on some ICU builds en-US hour12:false
  // renders 00:00 as "24" rather than "00", which would mislabel it as evening.
  const hour = parseInt(formatter.format(new Date(now)), 10) % 24;

  let timeOfDay: TimeOfDay;
  if (hour < 12) timeOfDay = 'morning';
  else if (hour < 17) timeOfDay = 'afternoon';
  else timeOfDay = 'evening';

  return { hour, timeOfDay };
}

/**
 * Get start of today in user's timezone as a UTC Date
 * @param timezone - IANA timezone string (e.g., "America/New_York")
 * @returns Date representing midnight in user's timezone, expressed as UTC
 */
export function getStartOfTodayInTimezone(timezone?: string | null): Date {
  const tz = normalizeTimezone(timezone);
  const now = new Date();

  // Format the current date in the user's timezone to get year/month/day
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts = formatter.formatToParts(now);
  const parsedYear = parseInt(parts.find(part => part.type === 'year')?.value ?? '', 10);
  const parsedMonth = parseInt(parts.find(part => part.type === 'month')?.value ?? '', 10);
  const parsedDay = parseInt(parts.find(part => part.type === 'day')?.value ?? '', 10);

  const year = Number.isNaN(parsedYear) ? now.getUTCFullYear() : parsedYear;
  const month = Number.isNaN(parsedMonth) ? now.getUTCMonth() + 1 : parsedMonth;
  const day = Number.isNaN(parsedDay) ? now.getUTCDate() : parsedDay;

  const utcMidnightMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);

  // Two-pass offset resolution keeps local midnight stable across DST boundaries.
  let timezoneOffsetMs = getTimezoneOffsetMilliseconds(new Date(utcMidnightMs), tz);
  let localMidnightUtcMs = utcMidnightMs - timezoneOffsetMs;

  const adjustedOffsetMs = getTimezoneOffsetMilliseconds(new Date(localMidnightUtcMs), tz);
  if (adjustedOffsetMs !== timezoneOffsetMs) {
    timezoneOffsetMs = adjustedOffsetMs;
    localMidnightUtcMs = utcMidnightMs - timezoneOffsetMs;
  }

  return new Date(localMidnightUtcMs);
}

/**
 * Pure renderer for the timestamp system-prompt section.
 *
 * Deterministic: the same `{ now, timezone }` always produces a byte-identical
 * string, with no internal clock read. The instant is floored to the cache
 * bucket (TIMESTAMP_BUCKET_MS) so repeat requests inside one cache window yield
 * an identical request body — the precondition for an OpenRouter cache HIT.
 * Seconds are dropped; the date uses explicit Intl fields (not `dateStyle`,
 * which throws when combined with `hour`/`minute`).
 */
export function formatTimestampContext(
  { now, timezone }: { now: number; timezone?: string | null },
): string {
  const tz = normalizeTimezone(timezone);
  const bucketedNow = new Date(floorToBucket(now, TIMESTAMP_BUCKET_MS));

  const currentTime = bucketedNow.toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });

  // Derive time-of-day from the bucketed instant too, so the whole block is
  // stable across a cache window (not just the rendered clock line).
  const { timeOfDay } = getUserTimeOfDay(tz, bucketedNow.getTime());

  return `

CURRENT TIMESTAMP CONTEXT:
• Current date and time (user's local time, rounded down to the latest 5-minute mark): ${currentTime}
• Time of day: ${timeOfDay}
• User's timezone: ${tz}
• When discussing schedules, deadlines, or time-sensitive matters, use this as your reference point
• For relative time references (e.g., "today", "tomorrow", "this week"), calculate from the current timestamp above in the user's timezone`;
}

/**
 * Build timestamp system prompt section
 * Provides current date and time context to AI models.
 *
 * Thin impure shell: the only clock read (confined to the `now` default arg)
 * delegates to the pure {@link formatTimestampContext}.
 * @param timezone - Optional IANA timezone string (e.g., "America/New_York"). Defaults to UTC.
 * @param now - Instant (epoch ms) to render; defaults to the current clock.
 */
export function buildTimestampSystemPrompt(
  timezone?: string | null,
  now: number = Date.now(),
): string {
  return formatTimestampContext({ now, timezone });
}

/**
 * Parse a date string that can be either ISO 8601 or natural language.
 * Uses chrono-node for natural language parsing with timezone awareness.
 * @param input - Date string (ISO 8601 or natural language)
 * @param referenceDate - Reference date for relative parsing (e.g., "tomorrow")
 * @param timezone - IANA timezone string for interpreting times (e.g., "America/New_York")
 */
export function parseDateTime(input: string, referenceDate?: Date, timezone?: string): Date {
  // Handle naive ISO datetimes first (no Z or offset) — interpret in the given timezone
  if (timezone && isNaiveISODatetime(input)) {
    return parseNaiveDatetimeInTimezone(input, timezone);
  }

  // Try strict ISO 8601 (with Z or offset, or date-only)
  const isoDate = new Date(input);
  if (!isNaN(isoDate.getTime())) {
    return isoDate;
  }

  // Natural language parsing via chrono-node with timezone-aware reference
  const ref: { instant: Date; timezone?: number } = {
    instant: referenceDate ?? new Date(),
  };
  if (timezone) {
    ref.timezone = getTimezoneOffsetMinutes(timezone, ref.instant);
  }

  const parsed = chrono.parseDate(input, ref, { forwardDate: true });
  if (!parsed) {
    throw new Error(`Could not parse date: "${input}". Use ISO 8601 format (e.g., "2024-01-15T10:00:00Z") or natural language (e.g., "tomorrow at 3pm", "next Monday 10am").`);
  }

  // Two-pass DST resolution: if the parsed date is in a different DST period
  // than the reference, the offset may be wrong. Recompute and re-parse.
  if (timezone) {
    const newOffset = getTimezoneOffsetMinutes(timezone, parsed);
    if (ref.timezone !== undefined && newOffset !== ref.timezone) {
      ref.timezone = newOffset;
      const corrected = chrono.parseDate(input, ref, { forwardDate: true });
      if (corrected) return corrected;
    }
  }

  return parsed;
}
