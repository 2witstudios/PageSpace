'use client';

import { useRouter } from 'next/navigation';
import { useApiClient } from '@/api/swr-provider';
import { createTaskList } from '@/ui/files/create-file/create-file';
import { localToday } from '../task-meta/task-meta';
import { listProgress } from '../task-tree/task-tree';
import { useDriveTaskLists, useDriveTasks, useTaskList, useTaskViewCounts } from '../use-tasks/use-tasks';
import { useAllDrives } from '../../frame/drives/use-section-scope';
import { DriveList } from '../../frame/drives/drive-list';
import { ListGroup } from '../../components/list-group/list-group';
import { taskViews, taskViewHref } from '../task-views/task-views';
import { useDriveNames } from '../../frame/drives/use-drive-names';
import { groundSections } from '../tasks-ground/ground-rows';
import { renderNewListButton, renderTaskGlance, renderTaskListRow, renderTaskViews, renderTasksPane } from './tasks-pane.render';
import { listMeta } from './list-meta';
import { TaskSiblings, useTaskHolder } from './task-siblings';

export type TasksPaneProps = {
  readonly driveId: string;
  /** The list open as the object, if any. */
  readonly selectedPageId: string | null;
  /** The smart view open as the object, if any. */
  readonly selectedViewId: string | null;
};

/** How many tasks the Needs attention glance shows before See all. */
const GLANCE_ROWS = 6;

/** Needs attention: the viewer's open tasks that are overdue or due this week, read from the same answer the Assigned view does. */
function TaskGlance({ driveId }: { readonly driveId: string }) {
  const allDrives = useAllDrives('tasks', driveId);
  const { response } = useDriveTasks(allDrives ? null : driveId, 'active', undefined);
  const driveNames = useDriveNames(allDrives);
  const due = response === undefined
    ? undefined
    : groundSections(response.tasks, localToday(new Date()), driveNames)
        .filter((section) => section.name !== 'Later')
        .flatMap((section) => section.rows);
  return renderTaskGlance({
    rows: due?.slice(0, GLANCE_ROWS),
    more: due === undefined ? 0 : Math.max(0, due.length - GLANCE_ROWS),
    // This week and Overdue are separate windows; Assigned to me holds both.
    moreHref: taskViewHref(driveId, 'assigned'),
  });
}

/**
 * The Tasks head's New list button. It makes an untitled task list at the drive's top and opens
 * it, where it can be renamed.
 */
export function NewTaskListAction({ driveId }: { readonly driveId: string }) {
  const { retry } = useDriveTaskLists(driveId);
  const client = useApiClient();
  const router = useRouter();
  return renderNewListButton(() =>
    void createTaskList(client, driveId).then((page) => {
      retry();
      router.push(`/${encodeURIComponent(driveId)}/tasks/${encodeURIComponent(page.id)}`);
    }),
  );
}

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

/**
 * The Tasks section's pane: the smart views with counts, then the drive's task lists with their
 * progress. Switched to All drives, the views and glance read every drive and the lists give way
 * to the drives to pick from.
 */
export function TasksPane({ driveId, selectedPageId, selectedViewId }: TasksPaneProps) {
  const allDrives = useAllDrives('tasks', driveId);
  const { lists, error, retry } = useDriveTaskLists(driveId);
  const { counts } = useTaskViewCounts(driveId, allDrives);
  const holder = useTaskHolder(driveId, selectedPageId);
  const views = renderTaskViews({
    views: taskViews.map((entry) => ({
      id: entry.id,
      label: entry.label,
      dotClass: entry.dotClass,
      warn: entry.warn,
      count: counts?.[entry.id],
      selected: entry.id === selectedViewId,
      href: taskViewHref(driveId, entry.id),
    })),
  });
  const glance = <TaskGlance driveId={driveId} />;
  // All drives lists the drives even beside an open task: the scope, not the open list, decides the pane.
  if (allDrives) {
    return (
      <>
        {views}
        {glance}
        <ListGroup label="Drives">
          <DriveList section="tasks" currentId={driveId} />
        </ListGroup>
      </>
    );
  }
  if (holder !== null && selectedPageId !== null) {
    return <TaskSiblings driveId={driveId} holder={holder} pageId={selectedPageId} />;
  }
  if (lists === undefined) {
    return (
      <>
        {views}
        {glance}
        {renderTasksPane(error === undefined ? { state: 'loading' } : { state: 'error', retry })}
      </>
    );
  }
  return (
    <>
      {views}
      {glance}
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
