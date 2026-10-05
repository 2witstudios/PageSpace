// Reading a task tree: where a task sits, whether it is done, and the rules
// PageSpace applies to statuses and nesting. Pure functions over the model.

import type { Task, TaskList, TaskStatus } from '../task-model/task';

/** PageSpace nests tasks five levels deep: top-level tasks are level 1. */
export const MAX_LEVELS = 5;

/** Where a task sits. */
export type TaskLocation = {
  readonly task: Task;
  /** The list holding the task: its statuses apply, and its page takes the task's writes. */
  readonly list: TaskList;
  /** Every task from the top down to this one; ends with the task itself. */
  readonly path: readonly Task[];
  /** The lists from the root down to the one holding the task; ends with that list. */
  readonly lists: readonly TaskList[];
};

/** Where a task sits; nothing for an id the tree does not hold. */
export const locate = (root: TaskList, id: string): TaskLocation | undefined => {
  for (const task of root.tasks) {
    if (task.id === id) return { task, list: root, path: [task], lists: [root] };
    const below = task.subtasks ? locate(task.subtasks, id) : undefined;
    if (below) return { ...below, path: [task, ...below.path], lists: [root, ...below.lists] };
  }
  return undefined;
};

/**
 * Whether a slug is done in a list. The group decides, not the slug; a list
 * with no statuses falls back to the literal "completed", as the server does.
 */
export const isDoneStatus = (statuses: readonly TaskStatus[], slug: string): boolean =>
  statuses.length === 0
    ? slug === 'completed'
    : statuses.find((status) => status.slug === slug)?.group === 'done';

/** Done by the status group of the list holding it. */
export const isDone = (list: TaskList, task: Task): boolean => isDoneStatus(list.statuses, task.status);

/** A list's status for a slug; nothing for one it does not define. */
export const statusOf = (list: TaskList, slug: string): TaskStatus | undefined =>
  list.statuses.find((status) => status.slug === slug);

const ordered = (statuses: readonly TaskStatus[]): readonly TaskStatus[] =>
  [...statuses].sort((a, b) => a.position - b.position);

/**
 * Where unticking lands: the first to-do, else the first status not done,
 * else the first. The same picks the server makes moving a row across the
 * done boundary, so the slug is always one the list defines.
 */
export const openStatus = (statuses: readonly TaskStatus[]): string => {
  const all = ordered(statuses);
  const pick =
    all.find((status) => status.group === 'todo') ?? all.find((status) => status.group !== 'done') ?? all[0];
  return pick?.slug ?? 'pending';
};

/** Where ticking lands: the first done status, else the last status. */
export const doneStatus = (statuses: readonly TaskStatus[]): string => {
  const all = ordered(statuses);
  const pick = all.find((status) => status.group === 'done') ?? all.at(-1);
  return pick?.slug ?? 'completed';
};

/**
 * The status a new task starts in when none is given: "pending" while the
 * list defines it as not done, else the list's open status — the create
 * route's resolveSeedStatus.
 */
export const seedStatus = (statuses: readonly TaskStatus[]): string => {
  const pending = statuses.find((status) => status.slug === 'pending');
  return pending !== undefined && pending.group !== 'done' ? 'pending' : openStatus(statuses);
};

/**
 * Why the server would refuse moving a task to this status, or null.
 *
 * Mirrors PATCH /tasks/[taskId] and its completion guard: any move into a
 * done status — even from another done status — is refused while one of the
 * task's direct subtasks has no completedAt. The counts are the server's own
 * (direct, untrashed subtasks), kept current by every local edit.
 */
export const completionRefusal = (
  statuses: readonly TaskStatus[],
  task: Task,
  slug: string,
): string | null => {
  if (!isDoneStatus(statuses, slug)) return null;
  const total = task.subTaskCount;
  const pending = total - Math.min(task.subTaskCompletedCount, total);
  return pending > 0 ? `Complete all sub-tasks first (${pending} of ${total} remaining)` : null;
};

export type Progress = { readonly done: number; readonly total: number };

/** A task's direct subtasks, completed and in all, as the server counts them. */
export const progress = (task: Task): Progress => ({
  done: task.subTaskCompletedCount,
  total: task.subTaskCount,
});

/** Every loaded task under a list, depth first. */
export const allTasks = (list: TaskList): readonly Task[] =>
  list.tasks.flatMap((task) => [task, ...(task.subtasks ? allTasks(task.subtasks) : [])]);

/** Every loaded task in a list at every level, each judged by its own list. */
export const listProgress = (list: TaskList): Progress =>
  list.tasks.reduce<Progress>(
    (sum, task) => {
      const below = task.subtasks ? listProgress(task.subtasks) : { done: 0, total: 0 };
      return {
        done: sum.done + below.done + (isDone(list, task) ? 1 : 0),
        total: sum.total + below.total + 1,
      };
    },
    { done: 0, total: 0 },
  );

/** Whether a task at this level may take subtasks. */
export const canNestUnder = (level: number): boolean => level < MAX_LEVELS;

/** Replaces the one task whose own page is `pageId`, wherever it sits. */
export const mapTaskByPage = (
  list: TaskList,
  pageId: string,
  change: (task: Task) => Task,
): TaskList => ({
  ...list,
  tasks: list.tasks.map((task) => {
    if (task.pageId === pageId) return change(task);
    if (!task.subtasks || locateByPage(task.subtasks, pageId) === undefined) return task;
    return { ...task, subtasks: mapTaskByPage(task.subtasks, pageId, change) };
  }),
});

/** The task whose own page is `pageId`. */
export const locateByPage = (list: TaskList, pageId: string): Task | undefined => {
  for (const task of list.tasks) {
    if (task.pageId === pageId) return task;
    const below = task.subtasks ? locateByPage(task.subtasks, pageId) : undefined;
    if (below) return below;
  }
  return undefined;
};

/** Hangs a loaded list of subtasks under the task whose page it is. */
export const withSubtasks = (root: TaskList, pageId: string, subtasks: TaskList): TaskList =>
  mapTaskByPage(root, pageId, (task) => ({ ...task, subtasks }));

export type DueTone = 'overdue' | 'soon' | 'later';

const DAY_MS = 86_400_000;

/**
 * How loudly a due date reads, by calendar day: overdue while open, soon
 * within three days, otherwise quiet. `today` is YYYY-MM-DD.
 */
export const dueTone = (dueDate: string, today: string, done: boolean): DueTone => {
  if (done) return 'later';
  const days = Math.round((Date.parse(dueDate.slice(0, 10)) - Date.parse(today)) / DAY_MS);
  if (days < 0) return 'overdue';
  return days <= 3 ? 'soon' : 'later';
};
