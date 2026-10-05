'use client';

import { useState, type ReactNode } from 'react';
import { edgeOf, renderErrorState } from '../../frame/edge-state/edge-state.render';
import { TASK_LIST_NOT_FOUND, renderNotFound } from '../../frame/not-found/not-found.render';
import { useUiState } from '../../store/store';
import type { UiState } from '../../store/state';
import { dispatch, transactions } from '../../store/transactions';
import { BoardView } from '../board-view/board-view';
import type { TaskList } from '../task-model/task';
import { listProgress } from '../task-tree/task-tree';
import { renderTreeView, type TaskNotice } from '../tree-view/tree-view.render';
import { doneToday, frontier } from '../focus-view/focus';
import { renderFocusView } from '../focus-view/focus-view.render';
import { useTaskView } from '../task-view/use-task-view';
import type { TaskViewName } from '../task-view/task-view';
import { useDriveTaskLists, useTaskList, type ActionResult, type TaskActions } from '../use-tasks/use-tasks';
import { taskHref } from '../task-object/task-route';
import { renderTaskListMessage, renderTaskListView } from './task-list-view.render';

export type TaskListViewProps = {
  readonly driveId: string;
  /** The TASK_LIST page the route opened. */
  readonly pageId: string;
  /** Whose view choice to restore and save. */
  readonly viewerId: string;
  /** What "today" is for Done today; the machine's clock unless a test injects one. */
  readonly clock?: () => Date;
};

const selectExpanded = (state: UiState) => state.resources.expandedTasks;

const systemClock = (): Date => new Date();

type Body = {
  readonly driveId: string;
  readonly list: TaskList | undefined;
  readonly view: TaskViewName;
  readonly expandedIds: readonly string[];
  readonly notice: TaskNotice | null;
  readonly actions: TaskActions;
  readonly report: (at: string) => (result: ActionResult) => void;
  readonly clock: () => Date;
};

const bodyFor = ({ driveId, list, view, expandedIds, notice, actions, report, clock }: Body): ReactNode => {
  if (list === undefined) return renderTaskListMessage('Loading tasks…', 'status');
  if (view === 'board') return <BoardView list={list} actions={actions} />;
  if (view === 'focus') {
    return renderFocusView({
      title: list.title,
      listPageId: list.pageId,
      groups: frontier(list),
      done: doneToday(list, clock()),
      notice,
      toggleComplete: (taskId) => {
        void actions.toggleComplete(taskId).then(report(taskId));
      },
      capture: (title) => {
        void actions.create(list.pageId, { title }).then(report(list.pageId));
      },
    });
  }
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
    taskHref: (task) => taskHref(driveId, task.pageId),
  });
};

/**
 * A drive's task list in the object slot. The tree, its writes and their
 * refusals come from useTaskList over the real task routes; the view choice
 * and which tasks are open are store resources.
 */
export function TaskListView({ driveId, pageId, viewerId, clock = systemClock }: TaskListViewProps) {
  const { lists } = useDriveTaskLists(driveId);
  const entry = lists?.find((candidate) => candidate.pageId === pageId);
  const title = entry?.title ?? '';
  const { list, error, actions, retry } = useTaskList(pageId, title);
  const [view, switchView] = useTaskView(viewerId);
  const expandedIds = useUiState(selectExpanded);
  const [notice, setNotice] = useState<TaskNotice | null>(null);
  const report = (at: string) => (result: ActionResult) =>
    setNotice(result.ok ? null : { at, message: result.refusal });
  // The drive's lists are the authority on which ids are its task lists; a
  // refused or unknown id says the same, so it never tells which it was.
  if ((lists !== undefined && entry === undefined) || (error !== undefined && edgeOf(error) === 'not-found')) {
    return renderNotFound({
      ...TASK_LIST_NOT_FOUND,
      homeHref: `/${encodeURIComponent(driveId)}/tasks`,
      linkLabel: 'Back to Tasks',
    });
  }
  if (list === undefined && error !== undefined) {
    return renderErrorState({ title: 'Could not load this task list', retry });
  }
  return renderTaskListView({
    title,
    progress: list === undefined ? undefined : listProgress(list),
    view,
    switchView,
    body: bodyFor({ driveId, list, view, expandedIds, notice, actions, report, clock }),
  });
}
