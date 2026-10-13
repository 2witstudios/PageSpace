'use client';

import type { ReactNode } from 'react';
import { localToday } from '../task-meta/task-meta';
import type { TaskListSummary } from '../task-model/task';
import { taskHref, taskRoute } from '../task-object/task-route';
import { listProgress } from '../task-tree/task-tree';
import { useDriveTaskLists, usePageTrail, useTaskList } from '../use-tasks/use-tasks';
import { renderTaskSiblings } from './task-siblings.render';
import { siblingGroups } from './sibling-groups';

/**
 * The list a task being opened sits in, when the route's page is a task
 * (not one of the drive's lists); null otherwise, or while that is unknown.
 */
export const useTaskHolder = (driveId: string, selectedPageId: string | null): TaskListSummary | null => {
  const { lists } = useDriveTaskLists(driveId);
  const isList = lists?.some((entry) => entry.pageId === selectedPageId) === true;
  const asksTrail = selectedPageId !== null && lists !== undefined && !isList;
  const { trail, error } = usePageTrail(asksTrail ? selectedPageId : null);
  if (!asksTrail || selectedPageId === null || lists === undefined) return null;
  const route = taskRoute(selectedPageId, lists, trail ?? (error === undefined ? undefined : null));
  return route.kind === 'task' ? route.list : null;
};

export type TaskSiblingsProps = {
  readonly driveId: string;
  readonly holder: TaskListSummary;
  /** The open task's page. */
  readonly pageId: string;
};

/** The open task's list, its tasks grouped by status, the open one highlighted. */
export function TaskSiblings({ driveId, holder, pageId }: TaskSiblingsProps): ReactNode {
  const { list } = useTaskList(holder.pageId, holder.title);
  if (list === undefined) {
    return (
      <p role="status" className="px-2 text-sm text-ink-muted">
        Loading tasks…
      </p>
    );
  }
  const groups = siblingGroups(list, pageId, (target) => taskHref(driveId, target), localToday(new Date()));
  if (groups === undefined) return null;
  return renderTaskSiblings({
    listHref: taskHref(driveId, holder.pageId),
    listTitle: holder.title,
    progress: listProgress(list),
    groups,
  });
}
