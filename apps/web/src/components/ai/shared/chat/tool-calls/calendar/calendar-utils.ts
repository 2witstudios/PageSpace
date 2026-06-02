/**
 * Shared formatting helpers for calendar tool-call renderers.
 *
 * Calendar tools return ISO `startAt`/`endAt` strings plus an IANA `timezone`.
 * These helpers format those instants in the event's timezone for display.
 */

/** Color category → dot color. Mirrors the calendar event color categories. */
const COLOR_DOT: Record<string, string> = {
  default: 'bg-slate-400',
  meeting: 'bg-blue-500',
  deadline: 'bg-red-500',
  personal: 'bg-emerald-500',
  travel: 'bg-amber-500',
  focus: 'bg-violet-500',
};

export const eventColorDot = (color?: string | null): string =>
  COLOR_DOT[(color ?? 'default').toLowerCase()] ?? COLOR_DOT.default;

const safeDate = (iso?: string): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
};

const fmt = (date: Date, options: Intl.DateTimeFormatOptions, timeZone?: string): string => {
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, ...(timeZone ? { timeZone } : {}) }).format(date);
  } catch {
    // Invalid timezone — fall back to local formatting
    return new Intl.DateTimeFormat('en-US', options).format(date);
  }
};

export const formatTime = (iso?: string, timeZone?: string): string => {
  const d = safeDate(iso);
  if (!d) return '';
  return fmt(d, { hour: 'numeric', minute: '2-digit' }, timeZone);
};

export const formatDayLabel = (iso?: string, timeZone?: string): string => {
  const d = safeDate(iso);
  if (!d) return '';
  return fmt(d, { weekday: 'short', month: 'short', day: 'numeric' }, timeZone);
};

/** A stable per-day key (YYYY-MM-DD in the given timezone) for grouping events. */
export const dayKey = (iso?: string, timeZone?: string): string => {
  const d = safeDate(iso);
  if (!d) return 'unknown';
  return fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' }, timeZone);
};

/** Full human range, e.g. "Mon, Jun 2 · 10:00 AM – 11:00 AM" or all-day variants. */
export const formatEventRange = (
  startAt?: string,
  endAt?: string,
  allDay?: boolean,
  timeZone?: string
): string => {
  const start = safeDate(startAt);
  if (!start) return '';
  const startDay = formatDayLabel(startAt, timeZone);

  if (allDay) {
    const endDay = formatDayLabel(endAt, timeZone);
    return endDay && endDay !== startDay ? `${startDay} – ${endDay} · all day` : `${startDay} · all day`;
  }

  const startTime = formatTime(startAt, timeZone);
  const end = safeDate(endAt);
  if (!end) return `${startDay} · ${startTime}`;

  const sameDay = dayKey(startAt, timeZone) === dayKey(endAt, timeZone);
  const endTime = formatTime(endAt, timeZone);
  return sameDay
    ? `${startDay} · ${startTime} – ${endTime}`
    : `${startDay} ${startTime} – ${formatDayLabel(endAt, timeZone)} ${endTime}`;
};

/**
 * Deep-link URL that opens a specific event in the calendar view.
 * `date` seeds the calendar's initial window so the event is loaded and its
 * modal can open. Returns null when there's no event id to link to.
 */
export const calendarEventHref = (event: {
  id?: string;
  driveId?: string | null;
  startAt?: string;
}): string | null => {
  if (!event.id) return null;
  const base = event.driveId ? `/dashboard/${event.driveId}/calendar` : '/dashboard/calendar';
  const params = new URLSearchParams({ eventId: event.id });
  if (event.startAt) params.set('date', event.startAt);
  return `${base}?${params.toString()}`;
};

/** RSVP / attendee status → tailwind text color. */
export const rsvpColor = (status?: string): string => {
  switch ((status ?? '').toUpperCase()) {
    case 'ACCEPTED':
      return 'text-green-600 dark:text-green-400';
    case 'DECLINED':
      return 'text-red-600 dark:text-red-400';
    case 'TENTATIVE':
      return 'text-amber-600 dark:text-amber-400';
    default:
      return 'text-muted-foreground';
  }
};
