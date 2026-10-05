'use client';

import { listProgress } from '../task-tree/task-tree';
import { useDriveTaskLists, useTaskList } from '../use-tasks/use-tasks';
import { renderTaskListRow, renderTasksPane } from './tasks-pane.render';

export type TasksPaneProps = {
  readonly driveId: string;
  /** The list open as the object, if any. */
  readonly selectedPageId: string | null;
};

type TaskListRowProps = {
  readonly driveId: string;
  readonly pageId: string;
  readonly title: string;
  readonly selected: boolean;
};

/**
 * One list's row. Its progress reads the same SWR entry the open list
 * does, so ticking a task in the Tree view moves this meter too.
 */
function TaskListRow({ driveId, pageId, title, selected }: TaskListRowProps) {
  const { list } = useTaskList(pageId, title);
  return renderTaskListRow({
    href: `/${encodeURIComponent(driveId)}/tasks/${encodeURIComponent(pageId)}`,
    title,
    selected,
    progress: list === undefined ? undefined : listProgress(list),
  });
}

/** The Tasks section's list pane: the drive's task lists with their progress. */
export function TasksPane({ driveId, selectedPageId }: TasksPaneProps) {
  const { lists, error } = useDriveTaskLists(driveId);
  if (lists === undefined) return renderTasksPane({ state: error === undefined ? 'loading' : 'error' });
  return renderTasksPane({
    state: 'ready',
    empty: lists.length === 0,
    rows: lists.map((entry) => (
      <TaskListRow
        key={entry.pageId}
        driveId={driveId}
        pageId={entry.pageId}
        title={entry.title}
        selected={entry.pageId === selectedPageId}
      />
    )),
  });
}
