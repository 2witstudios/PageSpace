// Edits to a task tree, applied locally the way the server will apply them:
// the same validation, the same completion guard, the same stamps and counts.
// A refused edit returns the tree unchanged with the server's own words, so a
// view can say why before a request is ever made.

import type { Assignee, Priority, Task, TaskList, TaskStatus } from '../task-model/task';
import {
  MAX_LEVELS,
  canNestUnder,
  completionRefusal,
  doneStatus,
  isDone,
  isDoneStatus,
  locate,
  locateByPage,
  mapTaskByPage,
  openStatus,
  seedStatus,
} from '../task-tree/task-tree';

/** An edit's result: the new tree, or the old one and why not. */
export type Outcome = {
  readonly list: TaskList;
  readonly refusal?: string;
};

const NOT_FOUND = 'Task not found';

/** The slugs PATCH accepts for a list that defines no statuses. */
const FALLBACK_SLUGS: readonly string[] = ['pending', 'in_progress', 'completed', 'blocked'];

const PRIORITIES: readonly string[] = ['low', 'medium', 'high'];

const refuse = (list: TaskList, refusal: string): Outcome => ({ list, refusal });

/** Applies a change to one task wherever it sits; `undefined` removes it. */
const mapTask = (list: TaskList, id: string, change: (task: Task) => Task | undefined): TaskList => ({
  ...list,
  tasks: list.tasks.flatMap((task) => {
    if (task.id === id) {
      const next = change(task);
      return next === undefined ? [] : [next];
    }
    return [task.subtasks ? { ...task, subtasks: mapTask(task.subtasks, id, change) } : task];
  }),
});

/** Replaces the list whose page is `pageId`: the root, or a task's subtasks. */
const mapList = (list: TaskList, pageId: string, change: (list: TaskList) => TaskList): TaskList =>
  list.pageId === pageId
    ? change(list)
    : {
        ...list,
        tasks: list.tasks.map((task) =>
          task.subtasks ? { ...task, subtasks: mapList(task.subtasks, pageId, change) } : task,
        ),
      };

/**
 * Moves a parent's subtask counts the way the server's will move: they count
 * direct, untrashed subtasks, and completed means completedAt is set.
 */
const recount = (root: TaskList, parent: Task | undefined, total: number, completed: number): TaskList => {
  if (parent === undefined || (total === 0 && completed === 0)) return root;
  return mapTask(root, parent.id, (task) => {
    const subTaskCount = Math.max(0, task.subTaskCount + total);
    return {
      ...task,
      subTaskCount,
      subTaskCompletedCount: Math.min(Math.max(0, task.subTaskCompletedCount + completed), subTaskCount),
    };
  });
};

const stamped = (task: { readonly completedAt: string | null }): number => (task.completedAt === null ? 0 : 1);

/** Why PATCH would reject this slug for a list, in its words; null when it would not. */
const invalidStatus = (statuses: readonly TaskStatus[], slug: string): string | null => {
  if (statuses.length === 0) return FALLBACK_SLUGS.includes(slug) ? null : 'Invalid status';
  return statuses.some((status) => status.slug === slug)
    ? null
    : `Invalid status "${slug}". Valid statuses: ${statuses.map((status) => status.slug).join(', ')}`;
};

/**
 * Moves a task to a status of the list holding it. A done status stamps
 * completedAt (again, if it was already done) and is refused while any direct
 * subtask is open; an open status clears it.
 */
export const setStatus = (root: TaskList, id: string, slug: string, now: string): Outcome => {
  const found = locate(root, id);
  if (found === undefined) return refuse(root, NOT_FOUND);
  const { task, list } = found;
  const refusal = invalidStatus(list.statuses, slug) ?? completionRefusal(list.statuses, task, slug);
  if (refusal !== null) return refuse(root, refusal);
  const completedAt = isDoneStatus(list.statuses, slug) ? now : null;
  const next = mapTask(root, id, (current) => ({ ...current, status: slug, completedAt }));
  return { list: recount(next, found.path.at(-2), 0, stamped({ completedAt }) - stamped(task)) };
};

/** The status ticking (or unticking) a task moves it to; nothing for an id the tree does not hold. */
export const toggledStatus = (root: TaskList, id: string): string | undefined => {
  const found = locate(root, id);
  if (found === undefined) return undefined;
  return isDone(found.list, found.task) ? openStatus(found.list.statuses) : doneStatus(found.list.statuses);
};

/** Ticks a task to its list's done status, or back to its open one. */
export const toggleComplete = (root: TaskList, id: string, now: string): Outcome => {
  const slug = toggledStatus(root, id);
  return slug === undefined ? refuse(root, NOT_FOUND) : setStatus(root, id, slug, now);
};

export type TaskPatch = {
  readonly title?: string;
  readonly priority?: Priority;
  /** An ISO date; null clears it. */
  readonly dueDate?: string | null;
};

/** Edits a task's own fields, validated as PATCH validates them. */
export const updateTask = (root: TaskList, id: string, patch: TaskPatch): Outcome => {
  if (locate(root, id) === undefined) return refuse(root, NOT_FOUND);
  if (patch.title !== undefined && patch.title.trim() === '') return refuse(root, 'Title cannot be empty');
  if (patch.priority !== undefined && !PRIORITIES.includes(patch.priority)) return refuse(root, 'Invalid priority');
  return {
    list: mapTask(root, id, (task) => ({
      ...task,
      ...patch,
      ...(patch.title === undefined ? {} : { title: patch.title.trim() }),
    })),
  };
};

const sameAssignee = (a: Assignee, b: Assignee): boolean => a.type === b.type && a.id === b.id;

/** Each person or agent once, first mention kept. */
export const uniqueAssignees = (assignees: readonly Assignee[]): readonly Assignee[] =>
  assignees.filter((entry, index) => assignees.findIndex((other) => sameAssignee(entry, other)) === index);

/** Replaces who is on a task, each person or agent once. */
export const setAssignees = (root: TaskList, id: string, assignees: readonly Assignee[]): TaskList =>
  mapTask(root, id, (task) => ({ ...task, assignees: uniqueAssignees(assignees) }));

/** A set of assignees with this one added, or taken off when already there. */
export const toggledAssignees = (assignees: readonly Assignee[], assignee: Assignee): readonly Assignee[] =>
  assignees.some((entry) => sameAssignee(entry, assignee))
    ? assignees.filter((entry) => !sameAssignee(entry, assignee))
    : [...assignees, assignee];

/** Puts a person or agent on a task, or takes them off. */
export const toggleAssignee = (root: TaskList, id: string, assignee: Assignee): TaskList => {
  const found = locate(root, id);
  return found === undefined ? root : setAssignees(root, id, toggledAssignees(found.task.assignees, assignee));
};

export type NewTask = {
  /** The list it goes in: the root list's page, or the page of the task it goes under. */
  readonly listPageId: string;
  /** Minted by the caller until the server's answer replaces it. */
  readonly id: string;
  readonly pageId: string;
  readonly title: string;
  readonly status?: string;
  readonly priority?: Priority;
  readonly dueDate?: string | null;
  readonly assignees?: readonly Assignee[];
  readonly now: string;
};

/**
 * Adds a task at the end of a list, as POST /tasks does: the list's seed status
 * unless one is given, stamped when that status is done, counted on its parent.
 * A task's first subtask opens its list with the statuses of the list holding
 * it, which is what the server seeds a sub-list with.
 */
export const addTask = (root: TaskList, draft: NewTask): Outcome => {
  const title = draft.title.trim();
  if (title === '') return refuse(root, 'Title is required');

  const owner = draft.listPageId === root.pageId ? undefined : locateByPage(root, draft.listPageId);
  const found = owner === undefined ? undefined : locate(root, owner.id);
  if (draft.listPageId !== root.pageId && found === undefined) return refuse(root, 'Task list not found');
  if (found !== undefined && !canNestUnder(found.path.length)) {
    return refuse(root, `Tasks nest ${MAX_LEVELS} levels deep at most`);
  }

  const holder = found?.list ?? root;
  const statuses = owner?.subtasks?.statuses ?? holder.statuses;
  const siblings = owner === undefined ? root.tasks : (owner.subtasks?.tasks ?? []);
  const status = draft.status ?? seedStatus(statuses);
  const refusal = invalidStatus(statuses, status);
  if (refusal !== null) return refuse(root, refusal);

  const completedAt = isDoneStatus(statuses, status) ? draft.now : null;
  const fresh: Task = {
    id: draft.id,
    pageId: draft.pageId,
    title,
    status,
    priority: draft.priority ?? 'medium',
    dueDate: draft.dueDate ?? null,
    completedAt,
    assignees: draft.assignees ?? [],
    position: Math.max(0, ...siblings.map((task) => task.position)) + 1,
    hasContent: false,
    subTaskCount: 0,
    subTaskCompletedCount: 0,
    updatedAt: draft.now,
    subtasks: null,
  };

  if (owner === undefined) return { list: { ...root, tasks: [...root.tasks, fresh] } };
  const opened = mapTaskByPage(root, owner.pageId, (task) => ({
    ...task,
    subtasks: {
      pageId: task.pageId,
      title: task.title,
      statuses,
      hasMore: false,
      ...(task.subtasks ?? {}),
      tasks: [...siblings, fresh],
    },
  }));
  return { list: recount(opened, owner, 1, stamped(fresh)) };
};

/** Removes a task and everything under it, uncounting it on its parent. */
export const removeTask = (root: TaskList, id: string): TaskList => {
  const found = locate(root, id);
  if (found === undefined) return root;
  return recount(
    mapTask(root, id, () => undefined),
    found.path.at(-2),
    -1,
    -stamped(found.task),
  );
};

/** The body PATCH /tasks/reorder takes for one list. */
export type ReorderPlan = {
  readonly listPageId: string;
  readonly tasks: readonly { readonly id: string; readonly position: number }[];
};

/**
 * Moves a task to an index among its siblings (clamped to the list), and
 * gives every sibling its new position for PATCH /tasks/reorder.
 */
export const moveTask = (
  root: TaskList,
  id: string,
  toIndex: number,
): { readonly list: TaskList; readonly order: ReorderPlan | null } => {
  const found = locate(root, id);
  if (found === undefined) return { list: root, order: null };
  const { task, list: holder } = found;
  const rest = holder.tasks.filter((entry) => entry.id !== id);
  const at = Math.min(Math.max(0, toIndex), rest.length);
  const tasks = [...rest.slice(0, at), task, ...rest.slice(at)].map((entry, position) => ({ ...entry, position }));
  return {
    list: mapList(root, holder.pageId, (list) => ({ ...list, tasks })),
    order: { listPageId: holder.pageId, tasks: tasks.map((entry) => ({ id: entry.id, position: entry.position })) },
  };
};
