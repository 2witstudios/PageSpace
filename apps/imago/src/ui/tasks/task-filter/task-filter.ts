// What the list strip's chips and search narrow an open list to. Pure
// functions over the task tree: a task stays when it matches, or when
// something under it does, so a match is always shown where it lives.

import type { Task, TaskList } from '../task-model/task';
import { isDone } from '../task-tree/task-tree';

/** The strip's chips: every task, the viewer's own, or the late ones. */
export type TaskChip = 'all' | 'mine' | 'overdue';

export type TaskFilter = {
  readonly chip: TaskChip;
  /** Matched against titles, ignoring case and surrounding space. */
  readonly query: string;
};

export const noFilter: TaskFilter = { chip: 'all', query: '' };

/** Who and when the chips read against. */
export type FilterContext = {
  readonly viewerId: string;
  /** The viewer's own day, YYYY-MM-DD. */
  readonly today: string;
};

const isMine = (task: Task, viewerId: string): boolean =>
  task.assignees.some((entry) => entry.type === 'user' && entry.id === viewerId);

const isOverdue = (list: TaskList, task: Task, today: string): boolean =>
  task.dueDate !== null && task.dueDate.slice(0, 10) < today && !isDone(list, task);

/** Whether one task, judged by the list holding it, passes the chip. */
export const passesChip = (chip: TaskChip, list: TaskList, task: Task, context: FilterContext): boolean => {
  if (chip === 'mine') return isMine(task, context.viewerId);
  if (chip === 'overdue') return isOverdue(list, task, context.today);
  return true;
};

const matchesQuery = (task: Task, query: string): boolean =>
  query === '' || task.title.toLowerCase().includes(query);

/** Whether a filter narrows anything at all. */
export const isFiltering = (filter: TaskFilter): boolean => filter.chip !== 'all' || filter.query.trim() !== '';

/**
 * The list with only the tasks that pass, and the parents above them. A
 * parent kept for a match below keeps only the branches that lead to one.
 */
export const filterTree = (list: TaskList, filter: TaskFilter, context: FilterContext): TaskList => {
  if (!isFiltering(filter)) return list;
  const query = filter.query.trim().toLowerCase();
  const narrow = (level: TaskList): TaskList => ({
    ...level,
    tasks: level.tasks.flatMap((task): Task[] => {
      const below = task.subtasks === null ? null : narrow(task.subtasks);
      const own = passesChip(filter.chip, level, task, context) && matchesQuery(task, query);
      if (!own && (below === null || below.tasks.length === 0)) return [];
      return [{ ...task, subtasks: below }];
    }),
  });
  return narrow(list);
};

export type ChipCounts = Readonly<Record<TaskChip, number>>;

/** How many loaded tasks, at every level, each chip holds: the counts the chips show. */
export const chipCounts = (list: TaskList, context: FilterContext): ChipCounts => {
  const counts = { all: 0, mine: 0, overdue: 0 };
  const walk = (level: TaskList) => {
    for (const task of level.tasks) {
      counts.all += 1;
      if (isMine(task, context.viewerId)) counts.mine += 1;
      if (isOverdue(level, task, context.today)) counts.overdue += 1;
      if (task.subtasks !== null) walk(task.subtasks);
    }
  };
  walk(list);
  return counts;
};

/** The ids of every parent kept for a match below it: opened while a filter is on, so matches show. */
export const openedForMatches = (list: TaskList): readonly string[] =>
  list.tasks.flatMap((task) =>
    task.subtasks !== null && task.subtasks.tasks.length > 0 ? [task.id, ...openedForMatches(task.subtasks)] : [],
  );
