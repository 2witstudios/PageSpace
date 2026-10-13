'use client';

import { useState } from 'react';
import type { StatusGroupFilter } from '../task-model/task';
import { localToday } from '../task-meta/task-meta';
import { groundHeading, useTaskViewStore, viewFor } from '../task-views/task-views';
import { useDriveTasks } from '../use-tasks/use-tasks';
import { groundSections, listCount } from './ground-rows';
import { renderTasksGround } from './tasks-ground.render';

/**
 * The Tasks ground: the viewer's tasks in the drive, for the view picked on
 * the pane and the status group picked here (Active by default).
 */
export function TasksGround({ driveId }: { readonly driveId: string }) {
  const view = useTaskViewStore((state) => state.view);
  const [status, setStatus] = useState<StatusGroupFilter>('active');
  const { response, error, retry } = useDriveTasks(driveId, status, viewFor(view).dueDateFilter);
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
        ? { kind: 'ready', driveId, sections: groundSections(tasks, today) }
        : error !== undefined
          ? { kind: 'error', retry }
          : { kind: 'loading' },
  });
}
