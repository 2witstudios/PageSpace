/**
 * Convert raw PostgreSQL timestamp strings to ISO format.
 *
 * Raw SQL returns timestamps without timezone info (e.g., "2026-02-02 15:30:00")
 * which JavaScript incorrectly interprets as local time instead of UTC.
 * This helper normalises them to proper ISO 8601 strings.
 */
export const toISOTimestamp = (timestamp: string | null): string | null => {
  if (!timestamp) return null;
  if (timestamp.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(timestamp)) {
    return timestamp;
  }
  return new Date(timestamp + 'Z').toISOString();
};
