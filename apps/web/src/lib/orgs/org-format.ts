/** Dates on org surfaces, in UTC because billing periods and caps are UTC (D20). */
const SHORT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const LONG = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** "Oct 1", or null for a missing or unparseable date. */
export function formatOrgShortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : SHORT.format(ms);
}

/** "Oct 1, 2026", or null for a missing or unparseable date. */
export function formatOrgLongDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : LONG.format(ms);
}
