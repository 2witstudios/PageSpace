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
export const absoluteInstant = z.preprocess(
  (value) => (typeof value === 'string' && isNaiveISODatetime(value) ? `${value.trim()}Z` : value),
  z.coerce.date(),
);

/** {@link absoluteInstant} for filters where the bound may be omitted. */
export const optionalAbsoluteInstant = z.preprocess(
  (value) => (typeof value === 'string' && isNaiveISODatetime(value) ? `${value.trim()}Z` : value),
  z.coerce.date().optional(),
);
