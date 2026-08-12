import { z } from 'zod';
import { isNaiveISODatetime } from '@/lib/ai/core/timestamp-utils';

/**
 * A query-parameter date bound: an ABSOLUTE instant.
 *
 * Range filters (`startDate`/`endDate` on listings, history, activity exports)
 * are not wall-clock times. A window spans rows that each carry their own zone,
 * so there is no single timezone to reinterpret it in — unlike a stored event's
 * own start/end, which the row's `timezone` owns and which
 * `parseDatetimeInTimezone` reads.
 *
 * The difference from a plain `z.coerce.date()` is a naive value
 * (`"2026-02-19T19:00:00"`): `new Date()` reads it in the *server process's*
 * local zone — UTC in deployment but the developer's zone under `next dev` — so
 * a range query silently meant different windows in different environments and
 * boundary bugs would not reproduce locally (#2404). Pinning it to UTC keeps
 * deployed behaviour identical and makes it reproducible everywhere else.
 *
 * Values that already carry `Z` or an offset are untouched, as are date-only
 * values (`"2026-02-19"`), which ISO 8601 already defines as UTC.
 */
const pinNaiveToUtc = (value: unknown) =>
  typeof value === 'string' && isNaiveISODatetime(value) ? `${value.trim()}Z` : value;

export const absoluteInstant = z.preprocess(pinNaiveToUtc, z.coerce.date());

/** {@link absoluteInstant} for filters where the bound may be omitted. */
export const optionalAbsoluteInstant = z.preprocess(pinNaiveToUtc, z.coerce.date().optional());

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The exclusive upper bound for an inclusive `endDate` filter.
 *
 * The two input shapes mean different things and only one of them wants a day
 * added:
 *
 * - `endDate=2026-02-19` names a DAY. "Through the 19th" includes everything
 *   that happened during it, so the exclusive bound is the start of the 20th.
 * - `endDate=2026-02-19T19:00:00Z` names an INSTANT and means exactly that.
 *   Adding a day here hands back 24 hours the caller never asked for.
 *
 * Callers used to add the day unconditionally, and with local `setDate` — so an
 * explicit instant was stretched by a day, and the stretch itself depended on
 * the server's own timezone. The day is added in UTC here for the same reason
 * the bounds are parsed in UTC: a range must not mean different things in
 * different deployments (#2404).
 *
 * Takes the RAW query string because the parsed `Date` cannot answer the
 * question — a date-only value and an explicit `T00:00:00Z` both land on UTC
 * midnight, and guessing from the instant would silently mis-handle one of them.
 */
export function exclusiveEndBound(raw: string | null | undefined, parsed: Date): Date {
  if (!raw || !DATE_ONLY.test(raw.trim())) return parsed;
  const nextDay = new Date(parsed);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return nextDay;
}
