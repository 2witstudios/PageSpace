import { isCompletedStatus, type TaskItem, type TaskStatusConfig } from './task-list-types';

/** The counts behind a task list's progress line: "4 of 12 done · 2 on agents · 1 overdue". */
export interface TaskProgressSummary {
  readonly done: number;
  readonly total: number;
  /** Open tasks that have an agent assignee (legacy single or multi-assignee). */
  readonly onAgents: number;
  /** Open tasks whose due date has passed. */
  readonly overdue: number;
}

function hasAgentAssignee(task: TaskItem): boolean {
  if (task.assigneeAgentId) return true;
  return (task.assignees ?? []).some((assignee) => assignee.agentPageId !== null);
}

/** Pure: derives the progress counts from the loaded tasks. `now` is injected so overdue is testable. */
export function summarizeTaskProgress(
  tasks: readonly TaskItem[],
  statusConfigs: readonly TaskStatusConfig[],
  now: Date,
): TaskProgressSummary {
  let done = 0;
  let onAgents = 0;
  let overdue = 0;
  for (const task of tasks) {
    const isDone = isCompletedStatus(task.status, [...statusConfigs]);
    if (isDone) {
      done += 1;
      continue;
    }
    if (hasAgentAssignee(task)) onAgents += 1;
    if (task.dueDate !== null && Date.parse(task.dueDate) < now.getTime()) overdue += 1;
  }
  return { done, total: tasks.length, onAgents, overdue };
}

/** The visible progress line, with the same separators as the board. */
export function formatTaskProgress(summary: TaskProgressSummary): string {
  return `${summary.done} of ${summary.total} done · ${summary.onAgents} on agents · ${summary.overdue} overdue`;
}
