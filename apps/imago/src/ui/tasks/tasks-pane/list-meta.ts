// A task list's row meta line, read from the tasks the list has loaded: how
// many open tasks are overdue, due by the end of this week (the same window
// GET /api/tasks calls this_week), and assigned to an agent. Only what the
// loaded tree holds; a part that counts nothing is left out.

import { dueWindowOf } from '../task-meta/task-meta';
import type { TaskList } from '../task-model/task';
import { isDone } from '../task-tree/task-tree';

/** The meta line for a list, e.g. "1 overdue · 2 due this week"; empty when nothing counts. */
export const listMeta = (list: TaskList, today: string): string => {
  const open = list.tasks.filter((task) => !isDone(list, task));
  const windows = open.map((task) => dueWindowOf(task.dueDate, today, false));
  const overdue = windows.filter((window) => window === 'overdue').length;
  const thisWeek = windows.filter((window) => window === 'this_week').length;
  const agents = open.filter((task) => task.assignees.some((assignee) => assignee.type === 'agent')).length;
  return [
    overdue > 0 ? `${overdue} overdue` : null,
    thisWeek > 0 ? `${thisWeek} due this week` : null,
    agents > 0 ? `${agents} assigned to agents` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
};
