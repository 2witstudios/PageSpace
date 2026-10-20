// The Board view's model: a list's top-level tasks laid out in one column
// per status, optionally split into lanes, and the rules for moving a card
// between them. Pure functions over the task model; the drag wiring and the
// writes live in board-view.tsx.

import type { Segment } from '../../components/segmented-control/segmented-control.render';
import type { Assignee, Priority, Task, TaskList, TaskStatus } from '../task-model/task';
import type { ViewStorage } from '../task-view/task-view';
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
  wipLimit: null,
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

// ---------------------------------------------------------------------------
// Lanes: each column split across by a field of the task.

/** What the board's lanes split by; none keeps one lane of every card. */
export type LaneMode = 'none' | 'priority' | 'assignee';

export const laneModes: readonly Segment<LaneMode>[] = [
  { value: 'none', label: 'None' },
  { value: 'priority', label: 'Priority' },
  { value: 'assignee', label: 'Assignee' },
];

/** The write that puts a card in a lane: its priority, or who it is on. */
export type LaneChange =
  | { readonly field: 'priority'; readonly priority: Priority }
  | { readonly field: 'assignees'; readonly assignees: readonly Assignee[] };

/** One lane across every column; `change` is what a card dropped into it takes on. */
export type Lane = {
  readonly key: string;
  readonly label: string;
  readonly change: LaneChange | null;
};

const everyCard: Lane = { key: 'all', label: 'All tasks', change: null };

const priorities: readonly Priority[] = ['high', 'medium', 'low'];

const priorityName: Readonly<Record<Priority, string>> = { high: 'High', medium: 'Medium', low: 'Low' };

const priorityLanes: readonly Lane[] = priorities.map((priority) => ({
  key: `priority:${priority}`,
  label: `${priorityName[priority]} priority`,
  change: { field: 'priority', priority },
}));

const UNASSIGNED = 'assignee:none';

const assigneeKey = (assignee: Assignee) => `assignee:${assignee.type}:${assignee.id}`;

/**
 * The lane a card sits in. A task on several people sits in its first
 * one's lane, so every card is drawn once.
 */
export const laneKeyOf = (task: Task, mode: LaneMode): string => {
  if (mode === 'priority') return `priority:${task.priority}`;
  if (mode === 'assignee') {
    const first = task.assignees[0];
    return first === undefined ? UNASSIGNED : assigneeKey(first);
  }
  return everyCard.key;
};

/**
 * The lanes a list's board shows. Priority always gives all three, so an
 * empty one can still be dropped into; Assignee gives one per first
 * assignee in list order, then Unassigned.
 */
export const boardLanes = (list: TaskList, mode: LaneMode): readonly Lane[] => {
  if (mode === 'priority') return priorityLanes;
  if (mode === 'none') return [everyCard];
  const seen = new Map<string, Lane>();
  for (const task of list.tasks) {
    const first = task.assignees[0];
    if (first === undefined || seen.has(assigneeKey(first))) continue;
    seen.set(assigneeKey(first), {
      key: assigneeKey(first),
      label: first.name === '' ? 'Unnamed' : first.name,
      change: { field: 'assignees', assignees: [first] },
    });
  }
  return [...seen.values(), { key: UNASSIGNED, label: 'Unassigned', change: { field: 'assignees', assignees: [] } }];
};

/** One lane's share of one column: where a card is dropped. */
export type BoardCell = {
  /** Unique across the board: the drop target's id. */
  readonly id: string;
  readonly lane: Lane;
  readonly status: TaskStatus;
  readonly tasks: readonly Task[];
};

export type BoardRow = { readonly lane: Lane; readonly cells: readonly BoardCell[] };

export const cellId = (laneKey: string, slug: string): string => `${laneKey}::${slug}`;

/** The board's lanes, each holding one cell per column, the cards in list order. */
export const boardRows = (columns: readonly BoardColumn[], lanes: readonly Lane[], mode: LaneMode): readonly BoardRow[] =>
  lanes.map((lane) => ({
    lane,
    cells: columns.map((column) => ({
      id: cellId(lane.key, column.status.slug),
      lane,
      status: column.status,
      tasks: column.tasks.filter((task) => laneKeyOf(task, mode) === lane.key),
    })),
  }));

// ---------------------------------------------------------------------------
// Dropping a card: which status, where in the order, and which lane.

/** Whether a card lands before or after the card it is dropped on. */
export type DropPlace = 'before' | 'after';

/** What a card was let go over: another card, or a cell's open space. */
export type DropTarget =
  | { readonly kind: 'card'; readonly overId: string; readonly place: DropPlace }
  | { readonly kind: 'cell' };

/**
 * Before or after the card it is over. Within one cell the order decides,
 * as a sorted list does: a card carried down lands after, one carried up
 * lands before. From another cell, it is which half the card is held over.
 */
export const dropPlace = (cell: BoardCell, activeId: string, overId: string, heldBelow: boolean): DropPlace => {
  const ids = cell.tasks.map((task) => task.id);
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from !== -1 && to !== -1) return from < to ? 'after' : 'before';
  return heldBelow ? 'after' : 'before';
};

/**
 * Where among the list's top-level tasks a dropped card goes, counted as
 * moveTask counts (among the others, the card itself taken out). Positions
 * are one order across every column, so the card lands next to the one it
 * was dropped on; dropped on open space, after the cell's last card; into an
 * empty cell, where it already is.
 */
export const dropIndex = (tasks: readonly Task[], taskId: string, cell: BoardCell, target: DropTarget): number => {
  const rest = tasks.filter((task) => task.id !== taskId);
  const current = tasks.findIndex((task) => task.id === taskId);
  if (target.kind === 'card') {
    if (target.overId === taskId) return current;
    const at = rest.findIndex((task) => task.id === target.overId);
    if (at !== -1) return at + (target.place === 'after' ? 1 : 0);
  }
  const last = [...cell.tasks].reverse().find((task) => task.id !== taskId);
  return last === undefined ? current : rest.findIndex((task) => task.id === last.id) + 1;
};

/** The writes a drop asks for; each part is absent when it changes nothing. */
export type DropPlan = {
  readonly status: TaskStatus;
  /** The status is another than the card's own. */
  readonly statusChanged: boolean;
  /** The card's new index among the list's top-level tasks; null when it keeps its place. */
  readonly index: number | null;
  /** The field the cell's lane gives the card; null in its own lane. */
  readonly change: LaneChange | null;
};

/**
 * What dropping a card on a cell writes, or null when the drop moves
 * nothing. A board that is not `reorderable` (it shows a filtered list,
 * whose order is not the list's) changes status and lane but never order.
 */
export const planDrop = (
  list: TaskList,
  columns: readonly BoardColumn[],
  taskId: string,
  cell: BoardCell,
  target: DropTarget,
  mode: LaneMode,
  reorderable = true,
): DropPlan | null => {
  const current = list.tasks.findIndex((task) => task.id === taskId);
  const task = list.tasks[current];
  if (task === undefined) return null;
  const statusChanged = dropStatus(columns, taskId, cell.status.slug) !== null;
  const index = dropIndex(list.tasks, taskId, cell, target);
  const change = laneKeyOf(task, mode) === cell.lane.key ? null : cell.lane.change;
  const moved = !reorderable || index === current ? null : index;
  if (!statusChanged && moved === null && change === null) return null;
  return { status: cell.status, statusChanged, index: moved, change };
};

// ---------------------------------------------------------------------------
// Work-in-progress limits: advisory, never enforced.

/** How a column's count stands against its limit. */
export type WipTone = 'under' | 'at' | 'over';

/** Null for a column with no limit. */
export const wipTone = (count: number, limit: number | null): WipTone | null => {
  if (limit === null) return null;
  if (count > limit) return 'over';
  return count === limit ? 'at' : 'under';
};

/** A typed limit: blank clears it; anything else goes to setWipLimit, which refuses what is not 1–999. */
export const parseWipLimit = (draft: string): number | null => (draft.trim() === '' ? null : Number(draft.trim()));

// ---------------------------------------------------------------------------
// What a viewer chose for a list's board, kept in this browser. Storage can
// refuse (private windows, blocked site data): then the choice lasts as long
// as the board is open.

export const collapsedKey = (listPageId: string): string => `imago:board-collapsed:${listPageId}`;

export const lanesKey = (listPageId: string): string => `imago:board-lanes:${listPageId}`;

/** The slugs of the columns this viewer folded to a rail; none when unknown. */
export const readCollapsed = (storage: ViewStorage | null, listPageId: string): readonly string[] => {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(collapsedKey(listPageId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((slug): slug is string => typeof slug === 'string') : [];
  } catch {
    return [];
  }
};

export const writeCollapsed = (storage: ViewStorage | null, listPageId: string, slugs: readonly string[]): void => {
  try {
    storage?.setItem(collapsedKey(listPageId), JSON.stringify(slugs));
  } catch {
    // The board still holds the choice; it just will not outlive the tab.
  }
};

/** Folds a column that is open, opens one that is folded. */
export const toggledCollapsed = (slugs: readonly string[], slug: string): readonly string[] =>
  slugs.includes(slug) ? slugs.filter((entry) => entry !== slug) : [...slugs, slug];

const isLaneMode = (value: string | null): value is LaneMode => laneModes.some((mode) => mode.value === value);

export const readLaneMode = (storage: ViewStorage | null, listPageId: string): LaneMode => {
  try {
    const stored = storage?.getItem(lanesKey(listPageId)) ?? null;
    return isLaneMode(stored) ? stored : 'none';
  } catch {
    return 'none';
  }
};

export const writeLaneMode = (storage: ViewStorage | null, listPageId: string, mode: LaneMode): void => {
  try {
    storage?.setItem(lanesKey(listPageId), mode);
  } catch {
    // As for the folded columns: the choice lasts for the session.
  }
};
