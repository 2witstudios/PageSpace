/**
 * UTC date utilities for consistent date handling across timezones
 */

/**
 * Get current date in YYYY-MM-DD format (UTC timezone)
 *
 * This ensures consistent date calculation regardless of server timezone.
 * Always use this for date-based operations like rate limiting.
 *
 * @returns Current date string in YYYY-MM-DD format (e.g., "2025-10-20")
 */
export function getTodayUTC(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Get tomorrow's midnight UTC as a timestamp
 *
 * Used for calculating "time until reset" messages in rate limiting
 *
 * @returns Timestamp (milliseconds) for midnight UTC tomorrow
 */
export function getTomorrowMidnightUTC(): number {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0
  ));
  return tomorrow.getTime();
}

/**
 * Get seconds until tomorrow midnight UTC
 *
 * @returns Number of seconds until midnight UTC tomorrow
 */
export function getSecondsUntilMidnightUTC(): number {
  const now = Date.now();
  const tomorrow = getTomorrowMidnightUTC();
  return Math.ceil((tomorrow - now) / 1000);
}

/**
 * Parse a date string in YYYY-MM-DD format to UTC timestamp
 *
 * @param dateString - Date in YYYY-MM-DD format
 * @returns UTC timestamp for midnight on that date
 */
export function parseDateUTC(dateString: string): number {
  const [year, month, day] = dateString.split('-').map(Number);
  return Date.UTC(year, month - 1, day, 0, 0, 0, 0);
}
