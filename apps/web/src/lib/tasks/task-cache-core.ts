/**
 * Pure transforms over a paginated task cache.
 *
 * Both task caches in the app hold the SAME shape — `TaskListData[]`, one entry
 * per loaded page: the top-level `useSWRInfinite` in TaskListView, and the
 * per-node `useTaskSubTasks` cache that an expanded row owns. That is what lets
 * one core serve optimistic updates at every depth.
 *
 * Every function returns a new array and never mutates its input, because SWR
 * compares by reference to decide whether to re-render. Returning the same
 * object with a mutated interior is a silent no-op.
 */

import type { TaskItem, TaskListData, TaskPriority, TaskAssigneeData, TaskStatusConfig } from
  '@/components/layout/middle-content/page-views/task-list/task-list-types';
import { isCompletedStatus } from
  '@/components/layout/middle-content/page-views/task-list/task-list-types';

/** The subset of a task row an optimistic write is allowed to touch. */
export interface TaskFieldPatch {
  status?: string;
  completedAt?: string | null;
  priority?: TaskPriority;
  title?: string;
  dueDate?: string | null;
  assignees?: TaskAssigneeData[];
  updatedAt?: string;
}

const patchTask = (task: TaskItem, patch: TaskFieldPatch): TaskItem => ({
  ...task,
  ...(patch.status !== undefined && { status: patch.status }),
  ...(patch.completedAt !== undefined && { completedAt: patch.completedAt }),
  ...(patch.priority !== undefined && { priority: patch.priority }),
  ...(patch.title !== undefined && { title: patch.title }),
  ...(patch.dueDate !== undefined && { dueDate: patch.dueDate }),
  ...(patch.assignees !== undefined && { assignees: patch.assignees }),
  ...(patch.updatedAt !== undefined && { updatedAt: patch.updatedAt }),
});

/**
 * Apply a field patch to one task, wherever it sits in the loaded pages.
 *
 * Pages that don't contain the task are returned by reference, so a 5-page list
 * re-renders one page's rows rather than all of them.
 */
export const applyTaskPatchToPages = (
  pages: TaskListData[] | undefined,
  taskId: string,
  patch: TaskFieldPatch,
): TaskListData[] | undefined => {
  if (!pages) return pages;
  let changed = false;
  const next = pages.map((page) => {
    if (!page.tasks.some((t) => t.id === taskId)) return page;
    changed = true;
    return { ...page, tasks: page.tasks.map((t) => (t.id === taskId ? patchTask(t, patch) : t)) };
  });
  return changed ? next : pages;
};

/**
 * Adjust a task's sub-task counters.
 *
 * These are computed server-side by grouping child pages on `pages.parentId`,
 * i.e. DIRECT children only — so completing a sub-task changes its immediate
 * parent's counters and nothing above that. There is no recursive bubbling to
 * model here, and adding one would put numbers on screen the server will
 * contradict on the next fetch.
 *
 * `subTaskCompletedCount` is clamped into [0, subTaskCount]: a double-click, or
 * an optimistic update racing a socket echo, must never render "3/2" or "-1/2".
 */
export const applySubTaskCountsToPages = (
  pages: TaskListData[] | undefined,
  taskId: string,
  delta: { total?: number; completed?: number },
): TaskListData[] | undefined => {
  if (!pages) return pages;
  if (!delta.total && !delta.completed) return pages;
  let changed = false;
  const next = pages.map((page) => {
    if (!page.tasks.some((t) => t.id === taskId)) return page;
    changed = true;
    return {
      ...page,
      tasks: page.tasks.map((t) => {
        if (t.id !== taskId) return t;
        const total = Math.max(0, (t.subTaskCount ?? 0) + (delta.total ?? 0));
        const completed = Math.min(
          Math.max(0, (t.subTaskCompletedCount ?? 0) + (delta.completed ?? 0)),
          total,
        );
        return { ...t, subTaskCount: total, subTaskCompletedCount: completed };
      }),
    };
  });
  return changed ? next : pages;
};

/**
 * The values a patch is about to overwrite, so a failed write can be undone
 * without asking the server.
 *
 * Returns only the keys the patch actually sets, read from the row as it stands
 * — so the inverse is exact rather than a guess at what "empty" looked like.
 * Null when the task is not in these pages, which is also the signal that there
 * is nothing to undo.
 */
export const invertTaskPatch = (
  pages: TaskListData[] | undefined,
  taskId: string,
  patch: TaskFieldPatch,
): TaskFieldPatch | null => {
  const task = pages?.flatMap((page) => page.tasks).find((t) => t.id === taskId);
  if (!task) return null;
  const inverse: TaskFieldPatch = {};
  for (const key of Object.keys(patch) as (keyof TaskFieldPatch)[]) {
    // Assigning through a union of optional fields one key at a time is not
    // something TS can narrow; the read and the write are the same key.
    (inverse as Record<string, unknown>)[key] = task[key as keyof TaskItem];
  }
  return inverse;
};

/**
 * Undo an optimistic patch — but only if it is still, in full, what is on
 * screen.
 *
 * All or nothing, deliberately. Deciding per field produces states that never
 * existed anywhere: complete a task, have the write 403, and meanwhile let a
 * foreign refetch land the same completion with the SERVER's timestamp — then
 * `status` still matches the guess and reverts, while `completedAt` does not
 * and stays. The row ends up open with a completion date, and somebody else's
 * legitimate completion has been silently undone. If any field moved on, this
 * write no longer owns the row and reverting any part of it is a guess.
 */
export const revertTaskPatch = (
  pages: TaskListData[] | undefined,
  taskId: string,
  applied: TaskFieldPatch,
  inverse: TaskFieldPatch | null,
): TaskListData[] | undefined => {
  if (!inverse) return pages;
  const task = pages?.flatMap((page) => page.tasks).find((t) => t.id === taskId);
  if (!task) return pages;
  const keys = Object.keys(applied) as (keyof TaskFieldPatch)[];
  if (keys.length === 0) return pages;
  const stillOurs = keys.every((key) => task[key as keyof TaskItem] === applied[key]);
  return stillOurs ? applyTaskPatchToPages(pages, taskId, inverse) : pages;
};

/**
 * Whether a newly created task can be appended straight into the cache.
 *
 * A new task lands at the end of the server's ordering. That is the last LOADED
 * page only when there are no unloaded pages after it — otherwise appending
 * would render it in a slot it doesn't occupy, and the illusion breaks the
 * moment the user clicks Load more.
 */
export const shouldAppendOptimistically = (pages: TaskListData[] | undefined): boolean =>
  !!pages && pages.length > 0 && !pages[pages.length - 1].hasMore;

/** Append to the last loaded page. Callers gate on `shouldAppendOptimistically`. */
export const appendTaskToPages = (
  pages: TaskListData[] | undefined,
  task: TaskItem,
): TaskListData[] | undefined => {
  if (!pages || pages.length === 0) return pages;
  const lastIndex = pages.length - 1;
  return pages.map((page, i) =>
    i === lastIndex ? { ...page, tasks: [...page.tasks, task] } : page,
  );
};

export const removeTaskFromPages = (
  pages: TaskListData[] | undefined,
  taskId: string,
): TaskListData[] | undefined => {
  if (!pages) return pages;
  let changed = false;
  const next = pages.map((page) => {
    if (!page.tasks.some((t) => t.id === taskId)) return page;
    changed = true;
    return { ...page, tasks: page.tasks.filter((t) => t.id !== taskId) };
  });
  return changed ? next : pages;
};

/**
 * Which slug a completion toggle should land on, given a list's vocabulary.
 *
 * Extracted from TaskListView's toggle handler so the header self-complete
 * control and nested rows resolve it identically.
 *
 * The 'completed' / 'pending' literals are used ONLY for a list with no configs
 * at all, where they are what the PATCH route itself assumes. With any configs,
 * falling back to a literal sends a slug the list does not define and PATCH
 * answers 400 — the checkbox paints, reverts, and toasts. That is reachable
 * without anything exotic: the statuses PUT lets a list regroup its only todo
 * status, and then reopening a task had nothing in the todo group to find.
 *
 * So the fallbacks stay inside the vocabulary, and they are the same ones the
 * server applies when it has to move a row across the same boundary (see
 * resolveVocabularyPicks in task-sync-service): for the open side, the first
 * todo, else the first non-done, else the first; for the done side, the first
 * done, else the last. Where a list genuinely has no status on the side asked
 * for, the result is a slug on the wrong side — which is the same compromise
 * the server makes, and far better than a 400 the user cannot act on.
 */
export const resolveToggleStatus = (
  configs: readonly TaskStatusConfig[],
  isCurrentlyDone: boolean,
): string => {
  if (configs.length === 0) return isCurrentlyDone ? 'pending' : 'completed';
  const ordered = [...configs].sort((a, b) => a.position - b.position);
  if (isCurrentlyDone) {
    return (ordered.find((c) => c.group === 'todo')
      ?? ordered.find((c) => c.group !== 'done')
      ?? ordered[0]).slug;
  }
  return (ordered.find((c) => c.group === 'done') ?? ordered[ordered.length - 1]).slug;
};

/**
 * The client-side half of the sub-task completion guard: a parent cannot be
 * completed while any of its sub-tasks is open. The server enforces the same
 * thing with a 422; this exists to avoid a pointless round trip and to say so
 * before the checkbox visibly flips.
 *
 * Returns null when completion is allowed.
 */
export const blockedByOpenSubTasks = (
  task: Pick<TaskItem, 'subTaskCount' | 'subTaskCompletedCount'>,
): { pending: number; total: number } | null => {
  const total = task.subTaskCount ?? 0;
  if (total <= 0) return null;
  const completed = Math.min(Math.max(task.subTaskCompletedCount ?? 0, 0), total);
  const pending = total - completed;
  return pending > 0 ? { pending, total } : null;
};

/**
 * The sub-task guard as it applies to ANY status change, not just the checkbox.
 *
 * A status dropdown can select a done-group status directly, which is the same
 * completion the checkbox performs — so it has to answer to the same rule, or
 * the UI optimistically completes a blocked task and then rolls back on the
 * server's 422.
 *
 * Only a transition INTO done is blocked. Moving between two open statuses is
 * unaffected, reopening is always allowed, and a task already done is left
 * alone: the server has accepted that state, and re-asserting it must not
 * become impossible just because a sub-task was added afterwards.
 */
export const blockedStatusTransition = (
  task: Pick<TaskItem, 'status' | 'subTaskCount' | 'subTaskCompletedCount'>,
  nextStatus: string,
  configs: readonly TaskStatusConfig[],
): { pending: number; total: number } | null => {
  const configList = [...configs];
  if (!isCompletedStatus(nextStatus, configList)) return null;
  if (isCompletedStatus(task.status, configList)) return null;
  return blockedByOpenSubTasks(task);
};

/** One wording for the block, so every entry point reports it identically. */
export const subTasksBlockedMessage = (blocked: { pending: number }): string =>
  `Finish ${blocked.pending} sub-task${blocked.pending > 1 ? 's' : ''} first`;

/**
 * Normalize a POST /tasks response into a full TaskItem.
 *
 * The create route returns the task with its relations but WITHOUT the derived
 * fields the list route computes — subTaskCount, subTaskCompletedCount,
 * hasContent, activeTriggerCount. A freshly created task has none of them, so
 * defaulting to zero/false is correct rather than merely convenient; leaving
 * them undefined would make `canExpandNode` and the sub-task fetch gate read
 * `undefined ?? 0` on a row that has a real answer.
 */
export type CreateTaskResponse =
  Omit<TaskItem, 'activeTriggerCount' | 'hasContent' | 'subTaskCount' | 'subTaskCompletedCount'>;

export const taskFromCreateResponse = (body: CreateTaskResponse): TaskItem => ({
  activeTriggerCount: 0,
  hasContent: false,
  subTaskCount: 0,
  subTaskCompletedCount: 0,
  ...body,
});
