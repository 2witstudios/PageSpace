// A calendar's arithmetic over plain days (YYYY-MM-DD). A day here has no
// zone: it is worked in UTC so the grid is the same in every runtime, and the
// caller turns the chosen day into whatever instant it stores. Names are
// written by hand rather than by Intl, as ui/time does, so the server and the
// browser draw the same text. Weeks start on Monday, as Imago's due windows do.

const DAY_MS = 86_400_000;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/** The column heads, Monday first. */
export const weekdayHeads: readonly { readonly short: string; readonly name: string }[] = WEEKDAYS.map((name) => ({
  short: name.slice(0, 2),
  name,
}));

/** A month on the calendar: its year and its 0-based month. */
export type Month = { readonly year: number; readonly month: number };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (value: number): string => String(value).padStart(2, '0');

const utc = (day: string): number | null => {
  const match = DAY.exec(day);
  if (match === null) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = Date.UTC(year, month - 1, date);
  const back = new Date(at);
  return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === date ? at : null;
};

const dayAt = (at: number): string => {
  const date = new Date(at);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
};

/** Whether a string names a real day. */
export const isDay = (day: string): boolean => utc(day) !== null;

/** The day `count` days after (or, negative, before) `day`. */
export const addDays = (day: string, count: number): string => {
  const at = utc(day);
  return at === null ? day : dayAt(at + count * DAY_MS);
};

/** The month a day falls in. */
export const monthOf = (day: string): Month => {
  const at = utc(day) ?? 0;
  const date = new Date(at);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
};

/** The month `count` months after (or before) `month`. */
export const addMonths = ({ year, month }: Month, count: number): Month => {
  const index = year * 12 + month + count;
  return { year: Math.floor(index / 12), month: ((index % 12) + 12) % 12 };
};

/** `October 2026`. */
export const monthTitle = ({ year, month }: Month): string => `${MONTHS[month] ?? ''} ${year}`;

/** Monday 0 … Sunday 6. */
const weekdayIndex = (day: string): number => ((new Date(utc(day) ?? 0).getUTCDay() + 6) % 7);

/** `Friday, October 23, 2026`: a day's full name, for its button. */
export const dayName = (day: string): string => {
  const at = utc(day);
  if (at === null) return '';
  const date = new Date(at);
  return `${WEEKDAYS[weekdayIndex(day)] ?? ''}, ${MONTHS[date.getUTCMonth()] ?? ''} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
};

/** `Fri`: a day's short weekday. */
export const weekdayShort = (day: string): string => (WEEKDAYS[weekdayIndex(day)] ?? '').slice(0, 3);

/**
 * `Fri 23` in today's month, `Fri 23 Oct` in another month of this year,
 * `Fri 23 Oct 2027` in another year: a chosen day as a control shows it.
 */
export const shortDayLabel = (day: string, today: string): string => {
  const at = utc(day);
  if (at === null) return '';
  const date = new Date(at);
  const base = `${weekdayShort(day)} ${date.getUTCDate()}`;
  if (day.slice(0, 7) === today.slice(0, 7)) return base;
  const month = (MONTHS[date.getUTCMonth()] ?? '').slice(0, 3);
  return day.slice(0, 4) === today.slice(0, 4) ? `${base} ${month}` : `${base} ${month} ${date.getUTCFullYear()}`;
};

/**
 * The six weeks a month's page shows, Monday first: the days before the 1st
 * and after the last come from the months either side, so every page is the
 * same 42 cells.
 */
export const monthGrid = ({ year, month }: Month): readonly (readonly string[])[] => {
  const first = dayAt(Date.UTC(year, month, 1));
  const start = addDays(first, -weekdayIndex(first));
  return Array.from({ length: 6 }, (_, week) => Array.from({ length: 7 }, (__, column) => addDays(start, week * 7 + column)));
};

/** Whether `day` lies in `month`. */
export const inMonth = (day: string, { year, month }: Month): boolean => {
  const of = monthOf(day);
  return of.year === year && of.month === month;
};

/** Whether `day` may be chosen: on or after `min` and on or before `max`, each when given. */
export const allowed = (day: string, min: string | undefined, max: string | undefined): boolean =>
  (min === undefined || min === '' || day >= min) && (max === undefined || max === '' || day <= max);

/** `day` pulled into the window: `min` when before it, `max` when after it, else `day` itself. */
export const clampDay = (day: string, min: string | undefined, max: string | undefined): string => {
  if (min !== undefined && min !== '' && day < min) return min;
  if (max !== undefined && max !== '' && day > max) return max;
  return day;
};

export type QuickPick = { readonly label: string; readonly day: string };

/** The picks offered above the calendar: today, tomorrow, a week and two weeks out. */
export const quickPicks = (today: string): readonly QuickPick[] => [
  { label: 'Today', day: today },
  { label: 'Tomorrow', day: addDays(today, 1) },
  { label: 'Next week', day: addDays(today, 7) },
  { label: 'In 2 weeks', day: addDays(today, 14) },
];

/** Where a key moves the focused day: arrows by a day or a week, Page keys by a month; null for any other key. */
export const dayForKey = (day: string, key: string): string | null => {
  switch (key) {
    case 'ArrowLeft':
      return addDays(day, -1);
    case 'ArrowRight':
      return addDays(day, 1);
    case 'ArrowUp':
      return addDays(day, -7);
    case 'ArrowDown':
      return addDays(day, 7);
    case 'Home':
      return addDays(day, -weekdayIndex(day));
    case 'End':
      return addDays(day, 6 - weekdayIndex(day));
    case 'PageUp':
    case 'PageDown': {
      const { year, month } = addMonths(monthOf(day), key === 'PageUp' ? -1 : 1);
      const date = Number(day.slice(8, 10));
      const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      return dayAt(Date.UTC(year, month, Math.min(date, last)));
    }
    default:
      return null;
  }
};
