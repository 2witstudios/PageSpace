'use client';

import { useState, type ReactNode } from 'react';
import { useUiState } from '../../store/store';
import type { UiState } from '../../store/state';
import { dispatch, transactions } from '../../store/transactions';
import type { TaskList } from '../task-model/task';
import { listProgress } from '../task-tree/task-tree';
import { renderTreeView, type TaskNotice } from '../tree-view/tree-view.render';
import { useTaskView } from '../task-view/use-task-view';
import type { TaskViewName } from '../task-view/task-view';
import { useDriveTaskLists, useTaskList, type ActionResult, type TaskActions } from '../use-tasks/use-tasks';
import { renderTaskListMessage, renderTaskListView } from './task-list-view.render';

export type TaskListViewProps = {
  readonly driveId: string;
  /** The TASK_LIST page the route opened. */
  readonly pageId: string;
  /** Whose view choice to restore and save. */
  readonly viewerId: string;
};

const selectExpanded = (state: UiState) => state.resources.expandedTasks;

/** Focus and Board are their own leaves (IMG-9.3, IMG-9.4); until they land, they say so. */
const comingViews: Readonly<Record<Exclude<TaskViewName, 'tree'>, string>> = {
  focus: 'Focus view is not available yet. Switch to Tree to work on this list.',
  board: 'Board view is not available yet. Switch to Tree to work on this list.',
};

type Body = {
  readonly list: TaskList | undefined;
  readonly error: unknown;
  readonly view: TaskViewName;
  readonly expandedIds: readonly string[];
  readonly notice: TaskNotice | null;
  readonly actions: TaskActions;
  readonly report: (at: string) => (result: ActionResult) => void;
};

const bodyFor = ({ list, error, view, expandedIds, notice, actions, report }: Body): ReactNode => {
  if (list === undefined) {
    return error === undefined
      ? renderTaskListMessage('Loading tasks…', 'status')
      : renderTaskListMessage('Could not load this task list.', 'alert');
  }
  if (view !== 'tree') return renderTaskListMessage(comingViews[view], 'status');
  return renderTreeView({
    list,
    expandedIds,
    notice,
    toggleExpanded: (taskId) => dispatch(transactions.toggleTaskExpanded, taskId),
    toggleComplete: (taskId) => {
      void actions.toggleComplete(taskId).then(report(taskId));
    },
    addTask: (listPageId, at, title) => {
      void actions.create(listPageId, { title }).then(report(at));
    },
  });
};

/**
 * A drive's task list in the object slot. The tree, its writes and their
 * refusals come from useTaskList over the real task routes; the view choice
 * and which tasks are open are store resources.
 */
export function TaskListView({ driveId, pageId, viewerId }: TaskListViewProps) {
  const { lists } = useDriveTaskLists(driveId);
  const title = lists?.find((entry) => entry.pageId === pageId)?.title ?? '';
  const { list, error, actions } = useTaskList(pageId, title);
  const [view, switchView] = useTaskView(viewerId);
  const expandedIds = useUiState(selectExpanded);
  const [notice, setNotice] = useState<TaskNotice | null>(null);
  const report = (at: string) => (result: ActionResult) =>
    setNotice(result.ok ? null : { at, message: result.refusal });
  return renderTaskListView({
    title,
    progress: list === undefined ? undefined : listProgress(list),
    view,
    switchView,
    body: bodyFor({ list, error, view, expandedIds, notice, actions, report }),
  });
}
