'use client';

import { useEffect, useState } from 'react';
import type { StatusGroupFilter } from '../task-model/task';
import { localToday } from '../task-meta/task-meta';
import { groundHeading, viewFor, type TaskViewId } from '../task-views/task-views';
import { useDriveTasks } from '../use-tasks/use-tasks';
import { useAllDrives } from '../../frame/drives/use-section-scope';
import { useDriveNames } from '../../frame/drives/use-drive-names';
import { groundSections, listCount } from './ground-rows';
import { renderTasksGround } from './tasks-ground.render';

/** Where the viewer's chosen status group is kept, per browser. */
export const STATUS_KEY = 'imago:tasks-ground-status';

const isStatusGroup = (value: string | null): value is StatusGroupFilter =>
  value === 'active' || value === 'completed' || value === 'all';

/** The status group this viewer last chose; Active when none is kept or storage is unavailable. */
export const storedStatus = (): StatusGroupFilter => {
  try {
    const value = localStorage.getItem(STATUS_KEY);
    return isStatusGroup(value) ? value : 'active';
  } catch {
    return 'active';
  }
};

const keepStatus = (status: StatusGroupFilter): void => {
  try {
    localStorage.setItem(STATUS_KEY, status);
  } catch {
    // A private window or blocked storage: the choice lasts this visit only.
  }
};

/**
 * A smart view's tasks, in the middle: the viewer's tasks in the drive, for the view picked on
 * the pane and the status group picked here (Active until the viewer picks
 * another, which is then remembered). With Tasks switched to All drives, it is the
 * viewer's tasks across every drive, each row naming its drive. Each row
 * ticks done in place.
 */
export function TasksGround({ driveId, view }: { readonly driveId: string; readonly view: TaskViewId }) {
  const allDrives = useAllDrives('tasks', driveId);
  const [status, setStatus] = useState<StatusGroupFilter>('active');
  const [notice, setNotice] = useState<{ readonly at: string; readonly message: string } | null>(null);
  // Read after mount, so the server's render and the first client render agree.
  useEffect(() => setStatus(storedStatus()), []);
  const { response, error, retry, toggleComplete } = useDriveTasks(allDrives ? null : driveId, status, viewFor(view).dueDateFilter);
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
    onStatus: (next) => {
      keepStatus(next);
      setNotice(null);
      setStatus(next);
    },
    toggleComplete: (taskId) => {
      setNotice(null);
      void toggleComplete(taskId).then((result) => setNotice(result.ok ? null : { at: taskId, message: result.refusal }));
    },
    notice,
    state:
      tasks !== undefined
        ? { kind: 'ready', sections: groundSections(tasks, today, driveNames) }
        : error !== undefined
          ? { kind: 'error', retry }
          : { kind: 'loading' },
  });
}
