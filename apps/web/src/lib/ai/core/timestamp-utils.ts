/**
 * Timestamp utilities for AI system prompts
 * Provides current date/time context to AI models for temporal awareness
 */

const DEFAULT_TIMEZONE = 'UTC';

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
 * Get user's time-of-day based on their timezone
 * @param timezone - IANA timezone string (e.g., "America/New_York")
 * @returns Object with hour and timeOfDay string
 */
export function getUserTimeOfDay(timezone?: string | null): { hour: number; timeOfDay: TimeOfDay } {
  const tz = normalizeTimezone(timezone);

  // Get the hour in the user's timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
  });

  const hour = parseInt(formatter.format(new Date()), 10);

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
  const year = parseInt(parts.find(p => p.type === 'year')?.value || '2024', 10);
  const month = parseInt(parts.find(p => p.type === 'month')?.value || '1', 10) - 1;
  const day = parseInt(parts.find(p => p.type === 'day')?.value || '1', 10);

  // Build the midnight candidate in UTC so host server timezone does not affect parsing.
  const utcMidnightCandidate = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));

  // Get the offset for that timezone at midnight
  const tzFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'longOffset',
  });
  const tzParts = tzFormatter.formatToParts(utcMidnightCandidate);
  const tzOffset = tzParts.find(p => p.type === 'timeZoneName')?.value || '+00:00';

  // Parse the offset (e.g., "GMT-05:00" or "GMT+05:30")
  if (tzOffset === 'GMT') {
    return utcMidnightCandidate;
  }

  const offsetMatch = tzOffset.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (offsetMatch) {
    const sign = offsetMatch[1] === '+' ? 1 : -1;
    const hours = parseInt(offsetMatch[2], 10);
    const minutes = parseInt(offsetMatch[3], 10);
    const offsetMs = sign * (hours * 60 + minutes) * 60 * 1000;

    // Return midnight in user's timezone as UTC
    return new Date(utcMidnightCandidate.getTime() - offsetMs);
  }

  // Fallback to UTC midnight
  return new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
}

/**
 * Build timestamp system prompt section
 * Provides current date and time context to AI models
 * @param timezone - Optional IANA timezone string (e.g., "America/New_York"). Defaults to UTC.
 */
export function buildTimestampSystemPrompt(timezone?: string | null): string {
  const tz = normalizeTimezone(timezone);

  const currentTime = new Date().toLocaleString('en-US', {
    timeZone: tz,
    dateStyle: 'full',
    timeStyle: 'long'
  });

  const { timeOfDay } = getUserTimeOfDay(tz);

  return `

CURRENT TIMESTAMP CONTEXT:
• Current date and time (user's local time): ${currentTime}
• Time of day: ${timeOfDay}
• User's timezone: ${tz}
• When discussing schedules, deadlines, or time-sensitive matters, use this as your reference point
• For relative time references (e.g., "today", "tomorrow", "this week"), calculate from the current timestamp above in the user's timezone`;
}
