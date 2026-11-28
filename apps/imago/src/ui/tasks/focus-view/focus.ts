// What the Focus view reads from a task tree: the frontier — the open leaves
// that can be done next, grouped under the parent they serve — and what was
// done today. Pure functions over the model; "today" is the clock the caller
// passes in, never the machine's.

import type { Task, TaskList } from '../task-model/task';
import { isDone } from '../task-tree/task-tree';

/** One parent's open leaves, or the list's own loose ones. */
export type FocusGroup = {
  /** The parent task's id, or the list's page id for its loose tasks. */
  readonly id: string;
  /** Where the leaves live: the parent's path from the top, or the list's title. */
  readonly heading: string;
  /** The list holding the leaves: its statuses apply, and its page takes their writes. */
  readonly list: TaskList;
  /** The parent; null for the list's loose tasks. */
  readonly parent: Task | null;
  readonly tasks: readonly Task[];
};

/** A task finished today, and the list whose statuses call it done. */
export type DoneEntry = { readonly task: Task; readonly list: TaskList };

/**
 * A task with nothing under it. A task the server counts subtasks for is a
 * parent even before they load, so it never shows as something to do next.
 */
const isLeaf = (task: Task): boolean =>
  task.subTaskCount === 0 && (task.subtasks === null || task.subtasks.tasks.length === 0);

/** Every list's open leaves, depth first; `path` is the parents above `list`. */
const groupsOf = (list: TaskList, path: readonly Task[]): readonly FocusGroup[] => {
  const open = list.tasks.filter((task) => isLeaf(task) && !isDone(list, task));
  const owner = path.at(-1);
  const own: readonly FocusGroup[] =
    open.length === 0
      ? []
      : [
          {
            id: owner?.id ?? list.pageId,
            heading: owner === undefined ? list.title : path.map((task) => task.title).join(' / '),
            list,
            parent: owner ?? null,
            tasks: open,
          },
        ];
  const below = list.tasks.flatMap((task) => (task.subtasks === null ? [] : groupsOf(task.subtasks, [...path, task])));
  // The list's loose tasks read after the parents' groups, as on the canvases.
  return owner === undefined ? [...below, ...own] : [...own, ...below];
};

const UNDATED = '9999-12-31';

/** The earliest due date a group carries: its parent's, else its leaves'. */
const earliest = (group: FocusGroup): string =>
  group.parent?.dueDate?.slice(0, 10) ??
  group.tasks
    .map((task) => task.dueDate?.slice(0, 10))
    .filter((due): due is string => due !== undefined)
    .sort()[0] ??
  UNDATED;

/**
 * The frontier: every open leaf at any depth, grouped under its parent,
 * soonest due first (undated groups keep tree order). Done is judged by the
 * list holding each leaf, since every level has its own statuses.
 */
export const frontier = (root: TaskList): readonly FocusGroup[] =>
  [...groupsOf(root, [])].sort((a, b) => earliest(a).localeCompare(earliest(b)));

/** Whether an ISO stamp falls on the same local calendar day as `now`. */
export const sameLocalDay = (iso: string, now: Date): boolean => {
  const stamp = new Date(iso);
  return (
    stamp.getFullYear() === now.getFullYear() &&
    stamp.getMonth() === now.getMonth() &&
    stamp.getDate() === now.getDate()
  );
};

const everyTask = (list: TaskList): readonly DoneEntry[] =>
  list.tasks.flatMap((task) => [{ task, list }, ...(task.subtasks === null ? [] : everyTask(task.subtasks))]);

/** Tasks at any depth that are done and were completed on `now`'s local day. */
export const doneToday = (root: TaskList, now: Date): readonly DoneEntry[] =>
  everyTask(root).filter(
    ({ task, list }) => isDone(list, task) && task.completedAt !== null && sameLocalDay(task.completedAt, now),
  );
