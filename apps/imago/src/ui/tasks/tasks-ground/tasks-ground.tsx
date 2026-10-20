'use client';

import { useMemo, useState } from 'react';
import useSWR from 'swr';
import type { StatusGroupFilter } from '../task-model/task';
import { localToday } from '../task-meta/task-meta';
import { groundHeading, useTaskViewStore, viewFor } from '../task-views/task-views';
import { useDriveTasks } from '../use-tasks/use-tasks';
import { DRIVES, drivesFrom } from '../../frame/drives/drives';
import { useHomeDriveId } from '../../frame/drives/home-drive-context';
import { groundSections, listCount } from './ground-rows';
import { renderTasksGround } from './tasks-ground.render';

/** Drive names by id from the shell's drive list, for naming each row's drive on Home. */
const useDriveNames = (enabled: boolean): ReadonlyMap<string, string> | undefined => {
  const { data } = useSWR<unknown>(enabled ? DRIVES : null);
  return useMemo(
    () => (enabled ? new Map((drivesFrom(data, null) ?? []).map((drive) => [drive.id, drive.name])) : undefined),
    [enabled, data],
  );
};

/**
 * The Tasks ground: the viewer's tasks in the drive, for the view picked on
 * the pane and the status group picked here (Active by default). On Home, the
 * dashboard, it is the viewer's tasks across every drive, each row naming its drive.
 */
export function TasksGround({ driveId }: { readonly driveId: string }) {
  const allDrives = driveId === useHomeDriveId();
  const view = useTaskViewStore((state) => state.view);
  const [status, setStatus] = useState<StatusGroupFilter>('active');
  const { response, error, retry } = useDriveTasks(allDrives ? null : driveId, status, viewFor(view).dueDateFilter);
  const driveNames = useDriveNames(allDrives);
  const today = localToday(new Date());
  const tasks = response?.tasks;
  const total = response?.pagination.total;
  const subtitle =
    total === undefined || tasks === undefined
      ? undefined
      : response?.pagination.hasMore
        ? `${total} tasks`
        : `${total} ${total === 1 ? 'task' : 'tasks'} in ${listCount(tasks)} ${listCount(tasks) === 1 ? 'list' : 'lists'}`;
  return renderTasksGround({
    heading: groundHeading(view),
    subtitle,
    status,
    onStatus: setStatus,
    state:
      tasks !== undefined
        ? { kind: 'ready', sections: groundSections(tasks, today, driveNames) }
        : error !== undefined
          ? { kind: 'error', retry }
          : { kind: 'loading' },
  });
}
