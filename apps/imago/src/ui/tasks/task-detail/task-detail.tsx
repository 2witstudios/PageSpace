'use client';

import { useState, type ReactNode } from 'react';
import { useUiState } from '../../store/store';
import type { UiState } from '../../store/state';
import { dispatch, transactions } from '../../store/transactions';
import type { TaskListSummary } from '../task-model/task';
import { locate, locateByPage } from '../task-tree/task-tree';
import type { TaskNotice } from '../tree-view/tree-view.render';
import { TaskDescription } from '../task-description/task-description';
import { useAssignable, useTaskList, type ActionResult } from '../use-tasks/use-tasks';
import { renderTaskDetail, renderTaskDetailMessage } from './task-detail.render';

export type TaskDetailProps = {
  /** The drive task list holding the task, at any depth. */
  readonly holder: TaskListSummary;
  /** The task's own page: the route's id. */
  readonly pageId: string;
  /** Where a task's detail or a list's view opens. */
  readonly hrefFor: (pageId: string) => string;
  readonly driveId: string;
};

const selectExpanded = (state: UiState) => state.resources.expandedTasks;

const NO_ONE = [] as const;

/**
 * A task's detail in the object slot. It reads and writes the very tree the
 * list's views do (one SWR entry per list, useTaskList), so every edit made
 * here shows in the Tree view and the list pane's progress as it is saved.
 */
export function TaskDetail({ holder, pageId, hrefFor, driveId }: TaskDetailProps): ReactNode {
  const { list: tree, error, actions } = useTaskList(holder.pageId, holder.title);
  const { assignable } = useAssignable(driveId);
  const expandedIds = useUiState(selectExpanded);
  const [notice, setNotice] = useState<TaskNotice | null>(null);
  if (tree === undefined) {
    return error === undefined
      ? renderTaskDetailMessage('Loading task…', 'status')
      : renderTaskDetailMessage('Could not load this task.', 'alert');
  }
  const task = locateByPage(tree, pageId);
  const found = task === undefined ? undefined : locate(tree, task.id);
  if (found === undefined) return renderTaskDetailMessage('This task could not be found.', 'alert');

  const id = found.task.id;
  const report = (at: string) => (result: ActionResult) =>
    setNotice(result.ok ? null : { at, message: result.refusal });
  const run = (at: string, write: Promise<ActionResult>) => {
    void write.then(report(at));
  };

  return renderTaskDetail({
    holder,
    path: found.path,
    list: found.list,
    assignable: assignable ?? NO_ONE,
    notice,
    expandedIds,
    hrefFor,
    description: <TaskDescription pageId={pageId} />,
    actions: {
      rename: (title) => run(id, actions.update(id, { title })),
      toggleComplete: (taskId) => run(taskId, actions.toggleComplete(taskId)),
      setStatus: (slug) => run(id, actions.setStatus(id, slug)),
      setPriority: (priority) => run(id, actions.update(id, { priority })),
      setDueDate: (dueDate) => run(id, actions.update(id, { dueDate })),
      toggleAssignee: (assignee) => run(id, actions.toggleAssignee(id, assignee)),
      toggleExpanded: (taskId) => dispatch(transactions.toggleTaskExpanded, taskId),
      addTask: (listPageId, at, title) => run(at, actions.create(listPageId, { title })),
    },
  });
}
