// What /imago/[driveId]/tasks/[pageId] opens. A task's own page is a
// TASK_LIST page too (it holds the task's subtasks), so the id alone does not
// say whether it names one of the drive's lists or a task inside one: the
// drive's lists answer the first, the page's ancestors the second.

import type { TrailEntry } from '../task-api/task-api';
import type { TaskListSummary } from '../task-model/task';

export type TaskRoute =
  | { readonly kind: 'loading' }
  /** One of the drive's task lists, opened as its view. */
  | { readonly kind: 'list'; readonly list: TaskListSummary }
  /** A task, opened as its detail inside the list holding it. */
  | { readonly kind: 'task'; readonly list: TaskListSummary }
  | { readonly kind: 'missing' };

/**
 * `lists` are the drive's own task lists (undefined while loading); `trail`
 * is the page's ancestors ending with itself (undefined while loading, null
 * when it could not be read). A task opens in the nearest list above it.
 */
export const taskRoute = (
  pageId: string,
  lists: readonly TaskListSummary[] | undefined,
  trail: readonly TrailEntry[] | null | undefined,
): TaskRoute => {
  if (lists === undefined) return { kind: 'loading' };
  const list = lists.find((entry) => entry.pageId === pageId);
  if (list !== undefined) return { kind: 'list', list };
  if (trail === undefined) return { kind: 'loading' };
  if (trail === null) return { kind: 'missing' };
  const holder = trail
    .filter((entry) => entry.id !== pageId)
    .reverse()
    .map((entry) => lists.find((summary) => summary.pageId === entry.id))
    .find((summary) => summary !== undefined);
  return holder === undefined ? { kind: 'missing' } : { kind: 'task', list: holder };
};

/** Where a list's view or a task's detail opens, basePath-relative. */
export const taskHref = (driveId: string, pageId: string): string =>
  `/${encodeURIComponent(driveId)}/tasks/${encodeURIComponent(pageId)}`;
