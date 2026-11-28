import {
  addDays,
  addMonths,
  addWeeks,
  endOfWeek,
  format,
  isValid,
  parseISO,
  startOfWeek,
  subDays,
  subMonths,
  subWeeks,
} from 'date-fns';
import type { CalendarViewMode } from '@/retained/components/calendar/calendar-types';

/** The calendar's address: what the pane and the middle share, kept in the URL so reload keeps it. */
export type CalendarState = {
  readonly view: CalendarViewMode;
  readonly date: Date;
  /** The event whose popover is open (the retained `eventId` deep link). */
  readonly eventId: string | null;
  /** Event creation is open (the pane's Event button). */
  readonly compose: boolean;
};

export type CalendarPatch = {
  readonly view?: string;
  readonly date?: string;
  readonly eventId?: string | null;
  readonly compose?: string | null;
};

export const calendarViews: readonly CalendarViewMode[] = ['day', 'week', 'month', 'agenda'];

export const defaultCalendarView: CalendarViewMode = 'week';

/** Monday-first, as the board draws the week (Mon Oct 12 – Sun Oct 18, 2026). */
export const WEEK_STARTS_ON = 1;

const isView = (value: string | null): value is CalendarViewMode =>
  calendarViews.some((view) => view === value);

const parseDate = (value: string | null, now: Date): Date => {
  if (value === null) return now;
  const parsed = parseISO(value);
  return isValid(parsed) ? parsed : now;
};

export const parseCalendarState = (params: URLSearchParams, now: Date): CalendarState => {
  const view = params.get('view');
  const eventId = params.get('eventId');
  return {
    view: isView(view) ? view : defaultCalendarView,
    date: parseDate(params.get('date'), now),
    eventId: eventId === null || eventId === '' ? null : eventId,
    compose: params.get('compose') === '1',
  };
};

/** The local calendar day, as the URL carries it. */
export const formatCalendarDate = (date: Date): string => format(date, 'yyyy-MM-dd');

/** The query string after `search` with `patch` applied; null values remove their key. */
export const withCalendarPatch = (search: string, patch: CalendarPatch): string => {
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
};

/** The toolbar's range: "Oct 12 – 18, 2026" for a week, a day's date, or the month. */
export const calendarRangeLabel = (view: CalendarViewMode, date: Date): string => {
  if (view === 'day') return format(date, 'EEEE, MMMM d, yyyy');
  if (view === 'week') {
    const start = startOfWeek(date, { weekStartsOn: WEEK_STARTS_ON });
    const end = endOfWeek(date, { weekStartsOn: WEEK_STARTS_ON });
    const endDay = start.getMonth() === end.getMonth() ? 'd' : 'MMM d';
    return `${format(start, 'MMM d')} – ${format(end, `${endDay}, yyyy`)}`;
  }
  return format(date, 'MMMM yyyy');
};

/** The unit the Previous and Next controls move by, in their labels. */
export const stepUnit = (view: CalendarViewMode): 'day' | 'week' | 'month' =>
  view === 'day' ? 'day' : view === 'week' ? 'week' : 'month';

export const stepCalendarDate = (view: CalendarViewMode, date: Date, direction: 1 | -1): Date => {
  if (view === 'day') return direction === 1 ? addDays(date, 1) : subDays(date, 1);
  if (view === 'week') return direction === 1 ? addWeeks(date, 1) : subWeeks(date, 1);
  return direction === 1 ? addMonths(date, 1) : subMonths(date, 1);
};

/** Where a new event starts: the next full hour today, else 9 AM on the viewed day. */
export const defaultNewEventRange = (date: Date, now: Date): { readonly startAt: Date; readonly endAt: Date } => {
  const startAt = new Date(date);
  if (startAt.toDateString() === now.toDateString()) {
    startAt.setMinutes(0, 0, 0);
    startAt.setHours(now.getHours() + 1);
  } else {
    startAt.setHours(9, 0, 0, 0);
  }
  const endAt = new Date(startAt);
  endAt.setHours(endAt.getHours() + 1);
  return { startAt, endAt };
};
