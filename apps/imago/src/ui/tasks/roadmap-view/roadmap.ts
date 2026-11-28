// The Roadmap's geometry and date math: which tasks draw a bar, a milestone or
// nothing; the span of days the timeline covers; where a day sits in pixels;
// the header's ticks per zoom; and what a drag does to a task's dates. Pure
// functions over calendar days (YYYY-MM-DD in the viewer's own zone), counted
// in UTC so no daylight-saving shift ever makes a day 23 or 25 hours long.

import type { Segment } from '../../components/segmented-control/segmented-control.render';
import { dueDateFor, dueDay } from '../task-detail/due-date';
import type { StatusGroup, Task, TaskList } from '../task-model/task';
import type { TaskPatch } from '../task-edit/task-edit';
import { isDone, statusOf } from '../task-tree/task-tree';

/** How far the timeline is zoomed. */
export type Zoom = 'weeks' | 'months' | 'quarter';

export const defaultZoom: Zoom = 'weeks';

export const zoomSegments: readonly Segment<Zoom>[] = [
  { value: 'weeks', label: 'Weeks' },
  { value: 'months', label: 'Months' },
  { value: 'quarter', label: 'Quarter' },
];

/** One day's width in pixels at each zoom. */
export const dayWidths: Readonly<Record<Zoom, number>> = { weeks: 36, months: 12, quarter: 4 };

/** How many days ‹ and › scroll by at each zoom: a week, a month, a quarter. */
export const periodDays: Readonly<Record<Zoom, number>> = { weeks: 7, months: 30, quarter: 91 };

const isZoom = (value: string | null): value is Zoom => value === 'weeks' || value === 'months' || value === 'quarter';

// ---------------------------------------------------------------------------
// Calendar days.

const DAY_MS = 86_400_000;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const pad = (value: number): string => String(value).padStart(2, '0');

/** Days since the epoch of a YYYY-MM-DD day; NaN for anything else. */
const dayNumber = (day: string): number => {
  const match = DAY.exec(day);
  if (match === null) return Number.NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS;
};

const fromNumber = (value: number): string => {
  const at = new Date(value * DAY_MS);
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
};

const utc = (day: string): Date => new Date(dayNumber(day) * DAY_MS);

/** The day `days` after `day` (before it when negative). */
export const addDays = (day: string, days: number): string => fromNumber(dayNumber(day) + days);

/** How many days `to` is after `from`; negative when it is before. */
export const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);

const minDay = (a: string, b: string): string => (a <= b ? a : b);
const maxDay = (a: string, b: string): string => (a >= b ? a : b);

/** `Oct 12`. */
export const shortDate = (day: string): string => {
  const at = utc(day);
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`;
};

/** `Tue 27`. */
export const weekdayDate = (day: string): string => {
  const at = utc(day);
  return `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()}`;
};

const isWeekend = (day: string): boolean => {
  const weekday = utc(day).getUTCDay();
  return weekday === 0 || weekday === 6;
};

// ---------------------------------------------------------------------------
// Rows.

/** What a row draws on the timeline. */
export type RowMark =
  | { readonly kind: 'bar'; readonly start: string; readonly due: string }
  | { readonly kind: 'milestone'; readonly due: string }
  /** An unscheduled task kept as a lane only to head its scheduled subtasks. */
  | { readonly kind: 'none' };

export type RoadmapRow = {
  readonly task: Task;
  /** The list holding the task: its statuses decide the tint. */
  readonly list: TaskList;
  /** 0 for a top-level task, 1 for its subtasks, and so on. */
  readonly depth: number;
  readonly mark: RowMark;
  readonly group: StatusGroup;
  readonly statusName: string;
  readonly done: boolean;
  /** 0 to 1: done is whole; otherwise the share of direct subtasks complete. */
  readonly progress: number;
  /** The open days past the due date up to today, for a task still not done. */
  readonly overdue: { readonly from: string; readonly to: string } | null;
};

/** A task's planned start, or the day it was made, as a calendar day. */
const startOf = (task: Task): string => dueDay(task.startDate) || dueDay(task.createdAt);

/** The mark a task draws: a bar, a subtask's milestone, or nothing undated. */
export const markOf = (task: Task, depth: number): RowMark => {
  const due = dueDay(task.dueDate);
  if (due === '') return { kind: 'none' };
  if (depth > 0 && dueDay(task.startDate) === '') return { kind: 'milestone', due };
  return { kind: 'bar', start: minDay(startOf(task), due), due };
};

/** Done is all; otherwise completed direct subtasks over all of them. */
export const progressOf = (task: Task, done: boolean): number => {
  if (done) return 1;
  if (task.subTaskCount <= 0) return 0;
  return Math.min(task.subTaskCompletedCount, task.subTaskCount) / task.subTaskCount;
};

/** The overdue span: from the day after the due date through today, while open. */
export const overdueOf = (
  due: string,
  today: string,
  done: boolean,
): { readonly from: string; readonly to: string } | null =>
  done || due >= today ? null : { from: addDays(due, 1), to: today };

const rowOf = (task: Task, list: TaskList, depth: number, today: string): RoadmapRow => {
  const done = isDone(list, task);
  const status = statusOf(list, task.status);
  const mark = markOf(task, depth);
  return {
    task,
    list,
    depth,
    mark,
    group: status?.group ?? (done ? 'done' : 'todo'),
    statusName: status?.name ?? task.status,
    done,
    progress: progressOf(task, done),
    overdue: mark.kind === 'none' ? null : overdueOf(mark.due, today, done),
  };
};

const rowsAt = (list: TaskList, depth: number, today: string): readonly RoadmapRow[] =>
  list.tasks.flatMap((task) => {
    const below = task.subtasks === null ? [] : rowsAt(task.subtasks, depth + 1, today);
    const row = rowOf(task, list, depth, today);
    return row.mark.kind === 'none' && below.length === 0 ? [] : [row, ...below];
  });

/**
 * The timeline's rows, in list order: each task, then its loaded subtasks a
 * level in. A task without a due date gets a lane only when something under
 * it is scheduled.
 */
export const roadmapRows = (list: TaskList, today: string): readonly RoadmapRow[] => rowsAt(list, 0, today);

/** Every loaded task with no due date, at any level, in list order. */
export const unscheduledTasks = (list: TaskList): readonly Task[] =>
  list.tasks.flatMap((task) => [
    ...(dueDay(task.dueDate) === '' ? [task] : []),
    ...(task.subtasks === null ? [] : unscheduledTasks(task.subtasks)),
  ]);

/** How a bar reads aloud: title, dates, status, and whether it is late. */
export const rowLabel = (row: RoadmapRow): string => {
  const { mark } = row;
  const dates =
    mark.kind === 'bar'
      ? `${shortDate(mark.start)} to ${shortDate(mark.due)}`
      : mark.kind === 'milestone'
        ? `due ${shortDate(mark.due)}`
        : 'unscheduled';
  return `${row.task.title}, ${dates}, ${row.statusName}${row.overdue === null ? '' : ', overdue'}`;
};

// ---------------------------------------------------------------------------
// The range and x positions.

export type Range = {
  /** The first day drawn. */
  readonly start: string;
  /** The last day drawn. */
  readonly end: string;
  /** How many days are drawn, both ends included. */
  readonly days: number;
};

/** The days a row's mark covers. */
const markDays = (mark: RowMark): readonly string[] =>
  mark.kind === 'bar' ? [mark.start, mark.due] : mark.kind === 'milestone' ? [mark.due] : [];

/**
 * From a week before the earliest start to three weeks past the latest due
 * date, and always holding today.
 */
export const rangeOf = (rows: readonly RoadmapRow[], today: string): Range => {
  const days = rows.flatMap((row) => markDays(row.mark));
  const first = days.reduce(minDay, today);
  const last = days.reduce(maxDay, today);
  const start = addDays(first, -7);
  const end = addDays(last, 21);
  return { start, end, days: daysBetween(start, end) + 1 };
};

/** Where a day's left edge sits on the timeline. */
export const xForDay = (range: Range, day: string, dayWidth: number): number =>
  daysBetween(range.start, day) * dayWidth;

/** The timeline's whole width. */
export const timelineWidth = (range: Range, dayWidth: number): number => range.days * dayWidth;

export type Span = { readonly left: number; readonly width: number };

/** Where a run of days sits, both ends included. */
export const spanOf = (range: Range, from: string, to: string, dayWidth: number): Span => ({
  left: xForDay(range, from, dayWidth),
  width: (daysBetween(from, to) + 1) * dayWidth,
});

/** The scroll offset that puts today a quarter of the way in from the left. */
export const todayScroll = (range: Range, today: string, dayWidth: number, viewport: number): number =>
  Math.max(0, xForDay(range, today, dayWidth) + dayWidth / 2 - viewport / 4);

// ---------------------------------------------------------------------------
// The header.

export type MonthLabel = { readonly day: string; readonly x: number; readonly label: string };

export type Tick = {
  readonly day: string;
  readonly x: number;
  /** The day of the month; empty where the zoom is too tight to label. */
  readonly label: string;
  readonly weekend: boolean;
};

export type Header = {
  readonly months: readonly MonthLabel[];
  readonly ticks: readonly Tick[];
  /** Weekend days, shaded in the Weeks zoom only. */
  readonly weekends: readonly Span[];
};

const everyDay = (range: Range): readonly string[] =>
  Array.from({ length: range.days }, (_, index) => addDays(range.start, index));

const monthLabel = (day: string): string => {
  const at = utc(day);
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
};

/**
 * Month names at each month's first day, and at the first day drawn when a
 * week or more of its month shows; ticks every day in Weeks, every Monday
 * otherwise, labelled with the date except in Quarter.
 */
export const headerOf = (range: Range, zoom: Zoom): Header => {
  const width = dayWidths[zoom];
  const days = everyDay(range);
  const firstOfMonth = (day: string) => day.endsWith('-01');
  const nextMonth = days.findIndex(firstOfMonth);
  const leadDays = nextMonth === -1 ? days.length : nextMonth;
  const months = days
    .filter((day, index) => firstOfMonth(day) || (index === 0 && leadDays >= 7))
    .map((day) => ({ day, x: xForDay(range, day, width), label: monthLabel(day) }));
  const ticks = days
    .filter((day) => zoom === 'weeks' || utc(day).getUTCDay() === 1)
    .map((day) => ({
      day,
      x: xForDay(range, day, width),
      label: zoom === 'quarter' ? '' : String(utc(day).getUTCDate()),
      weekend: isWeekend(day),
    }));
  const weekends =
    zoom === 'weeks' ? days.filter(isWeekend).map((day) => spanOf(range, day, day, width)) : [];
  return { months, ticks, weekends };
};

// ---------------------------------------------------------------------------
// Dragging.

/** What a drag holds: a bar's right edge, its left edge, or the whole of it. */
export type DragMode = 'due' | 'start' | 'move';

export type DragDates = { readonly start: string; readonly due: string };

/** How many whole days a pointer travel of `dx` pixels is. */
export const dayDelta = (dx: number, dayWidth: number): number => {
  const days = Math.round(dx / dayWidth);
  return days === 0 ? 0 : days;
};

/**
 * A mark's dates after a drag of `delta` days. The start never passes the
 * due date, and the due date never passes a start the task has set; a bar
 * that only starts where it was made follows its due date back instead. The
 * body moves both together.
 */
export const draggedDates = (dates: DragDates, mode: DragMode, delta: number, pinned = true): DragDates => {
  if (mode === 'move') return { start: addDays(dates.start, delta), due: addDays(dates.due, delta) };
  if (mode === 'start') return { start: minDay(addDays(dates.start, delta), dates.due), due: dates.due };
  const due = addDays(dates.due, delta);
  return pinned ? { start: dates.start, due: maxDay(due, dates.start) } : { start: minDay(dates.start, due), due };
};

/** The mode a drag really takes: a milestone, a single day, only ever moves. */
export const dragModeOf = (mark: RowMark, mode: DragMode): DragMode => (mark.kind === 'milestone' ? 'move' : mode);

/** Whether a row's start is the task's own, so its due date stops there. */
export const isPinned = (row: RoadmapRow): boolean => dueDay(row.task.startDate) !== '';

/** A mark's dates as a drag begins: a milestone starts on its due day. */
export const datesOf = (mark: RowMark): DragDates | null =>
  mark.kind === 'bar'
    ? { start: mark.start, due: mark.due }
    : mark.kind === 'milestone'
      ? { start: mark.due, due: mark.due }
      : null;

/**
 * What PATCH carries for a drag: the due date for the right edge, the start
 * for the left, both for a moved bar, and only the due date for a moved
 * milestone, which has no start. Nothing when no day changed.
 */
export const dragPatch = (
  mark: RowMark,
  before: DragDates,
  after: DragDates,
  mode: DragMode,
): TaskPatch | null => {
  if (before.start === after.start && before.due === after.due) return null;
  if (mode === 'due' || mark.kind === 'milestone') return { dueDate: dueDateFor(after.due) };
  if (mode === 'start') return { startDate: dueDateFor(after.start) };
  return { startDate: dueDateFor(after.start), dueDate: dueDateFor(after.due) };
};

const signed = (days: number): string => (days > 0 ? `+${days}d` : `${days}d`);

/** The drag tooltip: `Due Tue 27 · was Sat 24 · +3d`. */
export const dragLabel = (before: DragDates, after: DragDates, mode: DragMode): string => {
  const which = mode === 'start' ? 'start' : 'due';
  const name = which === 'start' ? 'Start' : 'Due';
  const from = before[which];
  const to = after[which];
  return `${name} ${weekdayDate(to)} · was ${weekdayDate(from)} · ${signed(daysBetween(from, to))}`;
};

/** How many days an arrow key moves a handle: one, or a week with Shift. */
export const keyDelta = (key: string, shift: boolean): number => {
  const step = shift ? 7 : 1;
  if (key === 'ArrowRight') return step;
  if (key === 'ArrowLeft') return -step;
  return 0;
};

// ---------------------------------------------------------------------------
// The saved zoom.

export type ZoomStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const zoomKey = (pageId: string): string => `imago:roadmap-zoom:${pageId}`;

/** The zoom saved for a list; null when there is none, or storage refuses. */
export const readZoom = (storage: ZoomStorage | null, pageId: string): Zoom | null => {
  try {
    const stored = storage?.getItem(zoomKey(pageId)) ?? null;
    return isZoom(stored) ? stored : null;
  } catch {
    return null;
  }
};

/** Saves a list's zoom; a storage that refuses keeps it for the session only. */
export const writeZoom = (storage: ZoomStorage | null, pageId: string, zoom: Zoom): void => {
  try {
    storage?.setItem(zoomKey(pageId), zoom);
  } catch {
    // The view still holds the zoom; it just will not outlive the tab.
  }
};
