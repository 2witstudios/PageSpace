'use client';

import { CreateActions } from '@/retained-adapters/create-actions';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/api/swr-provider';
import { createTaskList } from '@/ui/files/create-file/create-file';
import { localToday } from '../task-meta/task-meta';
import { listProgress } from '../task-tree/task-tree';
import { useDriveTaskLists, useTaskList, useTaskViewCounts } from '../use-tasks/use-tasks';
import { taskViews, useTaskViewStore } from '../task-views/task-views';
import { renderTaskListRow, renderTaskViews, renderTasksPane } from './tasks-pane.render';
import { listMeta } from './list-meta';
import { TaskSiblings, useTaskHolder } from './task-siblings';

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
 * One list's row. Its progress and meta read the same SWR entry the open list
 * does, so ticking a task in the Tree view moves this row too.
 */
function TaskListRow({ driveId, pageId, title, selected }: TaskListRowProps) {
  const { list } = useTaskList(pageId, title);
  return renderTaskListRow({
    href: `/${encodeURIComponent(driveId)}/tasks/${encodeURIComponent(pageId)}`,
    title,
    selected,
    progress: list === undefined ? undefined : listProgress(list),
    meta: list === undefined ? '' : listMeta(list, localToday(new Date())),
  });
}

/** The Tasks section's pane: the smart views with counts, then the drive's task lists with their progress. */
export function TasksPane({ driveId, selectedPageId }: TasksPaneProps) {
  const { lists, error, retry } = useDriveTaskLists(driveId);
  const { counts } = useTaskViewCounts(driveId);
  const view = useTaskViewStore((state) => state.view);
  const setView = useTaskViewStore((state) => state.setView);
  const holder = useTaskHolder(driveId, selectedPageId);
  const client = useApiClient();
  const router = useRouter();
  // New list makes an untitled task list at the drive's top and opens it, where it can be renamed.
  const newList = () =>
    void createTaskList(client, driveId).then((page) => {
      retry();
      router.push(`/${encodeURIComponent(driveId)}/tasks/${encodeURIComponent(page.id)}`);
    });
  if (holder !== null && selectedPageId !== null) {
    return <TaskSiblings driveId={driveId} holder={holder} pageId={selectedPageId} />;
  }
  const views = renderTaskViews({
    onNewList: newList,
    views: taskViews.map((entry) => ({
      id: entry.id,
      label: entry.label,
      dotClass: entry.dotClass,
      warn: entry.warn,
      count: counts?.[entry.id],
      selected: entry.id === view,
      onSelect: () => setView(entry.id),
    })),
  });
  if (lists === undefined) {
    return (
      <>
        <CreateActions driveId={driveId} />
        {views}
        {renderTasksPane(error === undefined ? { state: 'loading' } : { state: 'error', retry })}
      </>
    );
  }
  return (
    <>
      <CreateActions driveId={driveId} />
      {views}
      {renderTasksPane({
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
      })}
    </>
  );
}
