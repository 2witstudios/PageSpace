// The pane a task opens beside: which list the open task sits in, and its
// tasks grouped by that list's statuses. Pure apart from the list it is given.

import { defaultStatuses } from '../task-model/from-api';
import type { TaskList, TaskStatus } from '../task-model/task';
import { dueLabel } from '../task-meta/task-meta';
import { locate, locateByPage } from '../task-tree/task-tree';
import type { TaskSiblingGroup } from './task-siblings.render';

/**
 * The open task's siblings, grouped by status in the list's order. A task
 * whose status the list does not name lands in a last group of its own, so
 * no task is left out of the pane.
 */
export const siblingGroups = (
  tree: TaskList,
  pageId: string,
  hrefFor: (pageId: string) => string,
  today: string,
): readonly TaskSiblingGroup[] | undefined => {
  const task = locateByPage(tree, pageId);
  const found = task === undefined ? undefined : locate(tree, task.id);
  if (found === undefined) return undefined;
  const statuses: readonly TaskStatus[] = found.list.statuses.length === 0 ? defaultStatuses : found.list.statuses;
  const row = (entry: (typeof found.list.tasks)[number], group: TaskStatus['group']) => ({
    pageId: entry.pageId,
    href: hrefFor(entry.pageId),
    title: entry.title,
    group,
    due: dueLabel(entry.dueDate, today),
    current: entry.pageId === pageId,
  });
  const known = statuses.map((status) => ({
    name: status.name,
    rows: found.list.tasks.filter((entry) => entry.status === status.slug).map((entry) => row(entry, status.group)),
  }));
  const unknown = found.list.tasks.filter((entry) => !statuses.some((status) => status.slug === entry.status));
  return [...known, ...(unknown.length === 0 ? [] : [{ name: 'Other', rows: unknown.map((entry) => row(entry, 'todo')) }])].filter(
    (group) => group.rows.length > 0,
  );
};
