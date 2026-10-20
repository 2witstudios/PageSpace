import { parseDatetimeInTimezone } from '@/lib/ai/core/timestamp-utils';

export type TaskDateParseResult =
  | { ok: true; value: Date | null }
  | { ok: false };

/**
 * Parse a task date field (dueDate / startDate) from an unvalidated request body.
 * A falsy value clears the date (null). A naive ISO string ("2026-02-19T19:00") is
 * read in `timezone`; any other string or an epoch number goes through `new Date`.
 * Anything that does not yield a valid instant is rejected so the route can 400
 * instead of handing an Invalid Date to the database.
 */
export const parseTaskDateInput = (input: unknown, timezone: string): TaskDateParseResult => {
  if (!input) return { ok: true, value: null };
  if (typeof input !== 'string' && typeof input !== 'number') return { ok: false };
  let parsed: Date;
  try {
    parsed = typeof input === 'string' ? parseDatetimeInTimezone(input, timezone) : new Date(input);
  } catch {
    return { ok: false };
  }
  return Number.isNaN(parsed.getTime()) ? { ok: false } : { ok: true, value: parsed };
};

export const START_AFTER_DUE_ERROR = 'Start date must be on or before the due date';

/**
 * True when both dates are set and the start falls after the due date. The
 * comparison is of exact instants: the server has no viewer zone to read a
 * calendar day in. A client that picks whole days (Imago's date field and
 * Roadmap) sends a due day on the start's own day as the start's instant,
 * not that day's midnight, so it never sends a pair this refuses.
 */
export const isStartAfterDue = (
  startDate: Date | null | undefined,
  dueDate: Date | null | undefined,
): boolean => !!startDate && !!dueDate && startDate.getTime() > dueDate.getTime();
