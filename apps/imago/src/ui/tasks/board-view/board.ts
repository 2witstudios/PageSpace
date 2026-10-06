// The Board view's model: a list's top-level tasks laid out in one column
// per status, and the rules for moving a card between them. Pure functions
// over the task model; the drag wiring and the writes live in board-view.tsx.

import type { Task, TaskList, TaskStatus } from '../task-model/task';
import type { ActionResult } from '../use-tasks/use-tasks';

/** One status's column and the tasks shown in it. */
export type BoardColumn = {
  readonly status: TaskStatus;
  readonly tasks: readonly Task[];
};

const fallback = (slug: string, name: string, group: TaskStatus['group'], position: number): TaskStatus => ({
  id: `default-${slug}`,
  slug,
  name,
  color: '',
  group,
  position,
});

/**
 * The statuses the server accepts for a list that defines none, in the
 * order and under the names classic's board gives them (getStatusOrder,
 * DEFAULT_STATUS_CONFIG).
 */
const fallbackStatuses: readonly TaskStatus[] = [
  fallback('pending', 'To Do', 'todo', 0),
  fallback('in_progress', 'In Progress', 'in_progress', 1),
  fallback('blocked', 'Blocked', 'in_progress', 2),
  fallback('completed', 'Done', 'done', 3),
];

const columnStatuses = (list: TaskList): readonly TaskStatus[] =>
  list.statuses.length === 0 ? fallbackStatuses : [...list.statuses].sort((a, b) => a.position - b.position);

/**
 * A column per status of the list, in position order, each holding the
 * list's top-level tasks in that status in list order. A task whose slug the
 * list no longer defines is shown in the first column, as classic's board
 * shows it.
 */
export const boardColumns = (list: TaskList): readonly BoardColumn[] => {
  const statuses = columnStatuses(list);
  const known = new Set(statuses.map((status) => status.slug));
  const first = statuses[0]?.slug;
  const shownIn = (task: Task) => (known.has(task.status) ? task.status : first);
  return statuses.map((status) => ({
    status,
    tasks: list.tasks.filter((task) => shownIn(task) === status.slug),
  }));
};

const taskOf = (columns: readonly BoardColumn[], taskId: string): Task | undefined =>
  columns.flatMap((column) => column.tasks).find((task) => task.id === taskId);

/**
 * The statuses "Move to…" offers a task: every one but the status it is in.
 * A task shown in the first column for an unknown slug is not in the first
 * status, so it is offered that one too.
 */
export const moveTargets = (columns: readonly BoardColumn[], taskId: string): readonly TaskStatus[] => {
  const from = taskOf(columns, taskId)?.status;
  return columns.map((column) => column.status).filter((status) => status.slug !== from);
};

/**
 * The status a card dropped over `overId` moves to: the column's, when it is
 * another status than the card's own; null when the drop moves nothing.
 */
export const dropStatus = (columns: readonly BoardColumn[], taskId: string, overId: string | null): string | null => {
  const from = taskOf(columns, taskId);
  if (from === undefined || overId === null || overId === from.status) return null;
  return columns.some((column) => column.status.slug === overId) ? overId : null;
};

/** Where a column sits on screen, as the drag measures it. */
export type ColumnRect = {
  readonly id: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

type Box = Omit<ColumnRect, 'id'>;

/** How far below a column's top a card carried into it by keyboard lands. */
const LANDING = 8;

const steps: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1 };

/**
 * Where a card held by the keyboard goes on Left or Right: centred in the
 * next column that way, from the column it is over (or, just picked up, the
 * one its centre is in). Nothing at either end, or for any other key.
 */
export const columnJump = (
  key: string,
  rects: readonly ColumnRect[],
  overId: string | null,
  card: Box,
): { readonly x: number; readonly y: number } | undefined => {
  const step = steps[key];
  if (step === undefined) return undefined;
  const ordered = [...rects].sort((a, b) => a.left - b.left);
  const centre = card.left + card.width / 2;
  const at = ordered.findIndex((rect) =>
    overId === null ? centre >= rect.left && centre <= rect.left + rect.width : rect.id === overId,
  );
  const target = at === -1 ? undefined : ordered[at + step];
  if (target === undefined) return undefined;
  return { x: target.left + (target.width - card.width) / 2, y: target.top + LANDING };
};

/** What a screen reader hears once a move is saved or refused. */
export const moveAnnouncement = (title: string, statusName: string, result: ActionResult): string =>
  result.ok ? `Moved ${title} to ${statusName}.` : `Could not move ${title} to ${statusName}: ${result.refusal}`;
