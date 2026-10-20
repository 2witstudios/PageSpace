'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { edgeOf, renderErrorState } from '../../frame/edge-state/edge-state.render';
import { TASK_NOT_FOUND, renderNotFound } from '../../frame/not-found/not-found.render';
import { useUiState } from '../../store/store';
import type { UiState } from '../../store/state';
import { dispatch, transactions } from '../../store/transactions';
import type { Assignee, Task, TaskListSummary } from '../task-model/task';
import { locate, locateByPage } from '../task-tree/task-tree';
import type { TaskNotice } from '../tree-view/tree-view.render';
import { TaskDescription } from '../task-description/task-description';
import { TaskAgentTriggersDialog } from '@/retained/components/layout/middle-content/page-views/task-list/TaskAgentTriggersDialog';
import { localToday } from '../task-meta/task-meta';
import {
  useAssignable,
  usePageActivity,
  usePageEditable,
  useTaskList,
  useTaskTriggers,
  type ActionResult,
} from '../use-tasks/use-tasks';
import { renderTaskDetail, renderTaskDetailMessage, type TaskDetailRenderProps } from './task-detail.render';
import { activityRows, setByImago } from './task-activity';
import { automationRows } from './task-automations';
import { renderTaskActivity } from './task-activity.render';
import { renderTaskAutomations } from './task-automations.render';

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

/** A task id that names nothing the viewer can open in this drive, with the way back to its task lists. */
export const renderTaskNotFound = (driveId: string): ReactNode =>
  renderNotFound({ ...TASK_NOT_FOUND, homeHref: `/${encodeURIComponent(driveId)}/tasks`, linkLabel: 'Back to Tasks' });

/**
 * A task's detail in the object slot. It reads and writes the very tree the
 * list's views do (one SWR entry per list, useTaskList), so every edit made
 * here shows in the Tree view and the list pane's progress as it is saved.
 */
export function TaskDetail({ holder, pageId, hrefFor, driveId }: TaskDetailProps): ReactNode {
  const { list: tree, error, actions, retry } = useTaskList(holder.pageId, holder.title);
  const { assignable } = useAssignable(driveId);
  const expandedIds = useUiState(selectExpanded);
  const canEdit = usePageEditable(holder.pageId);
  const router = useRouter();
  const [notice, setNotice] = useState<TaskNotice | null>(null);
  const [deleting, setDeleting] = useState(false);
  if (tree === undefined) {
    if (error === undefined) return renderTaskDetailMessage('Loading task…', 'status');
    return edgeOf(error) === 'not-found'
      ? renderTaskNotFound(driveId)
      : renderErrorState({ title: 'Could not load this task', retry });
  }
  const task = locateByPage(tree, pageId);
  const found = task === undefined ? undefined : locate(tree, task.id);
  // A deleted task leaves the tree at once (the write is optimistic): say so
  // rather than "not found" until the list it sat in opens.
  if (found === undefined) return deleting ? renderTaskDetailMessage('Deleting task…', 'status') : renderTaskNotFound(driveId);

  const id = found.task.id;
  const report = (at: string) => (result: ActionResult) =>
    setNotice(result.ok ? null : { at, message: result.refusal });
  const run = (at: string, write: Promise<ActionResult>) => {
    void write.then(report(at));
  };
  const siblings = found.list.tasks;
  const index = siblings.findIndex((entry) => entry.id === id);
  const sibling = (offset: number): string | null => {
    const other: Task | undefined = index < 0 ? undefined : siblings[index + offset];
    return other === undefined ? null : hrefFor(other.pageId);
  };

  return (
    <OpenTask
      driveId={driveId}
      pageId={pageId}
      taskId={id}
      taskTitle={found.task.title}
      taskHasDueDate={found.task.dueDate !== null}
      listPageId={found.list.pageId}
      agents={(assignable ?? NO_ONE).filter((entry) => entry.type === 'agent')}
      renderProps={{
        driveId,
        holder,
        path: found.path,
        list: found.list,
        assignable: assignable ?? NO_ONE,
        notice,
        previousHref: sibling(-1),
        nextHref: sibling(1),
        today: localToday(new Date()),
        canEdit,
        expandedIds,
        hrefFor,
        description: <TaskDescription pageId={pageId} />,
        actions: {
          rename: (title) => run(id, actions.update(id, { title })),
          toggleComplete: (taskId) => run(taskId, actions.toggleComplete(taskId)),
          setStatus: (slug) => run(id, actions.setStatus(id, slug)),
          setPriority: (priority) => run(id, actions.update(id, { priority })),
          setDueDate: (dueDate) => run(id, actions.update(id, { dueDate })),
          setStartDate: (startDate) => run(id, actions.update(id, { startDate })),
          toggleAssignee: (assignee) => run(id, actions.toggleAssignee(id, assignee)),
          toggleExpanded: (taskId) => dispatch(transactions.toggleTaskExpanded, taskId),
          addTask: (listPageId, at, title) => run(at, actions.create(listPageId, { title })),
          remove: () => {
            setDeleting(true);
            void actions.remove(id).then((result) => {
              if (result.ok) {
                router.push(hrefFor(holder.pageId));
                return;
              }
              setDeleting(false);
              setNotice({ at: id, message: result.refusal });
            });
          },
        },
      }}
    />
  );
}

/**
 * The open task's own data: its triggers (the Automations section, hidden for
 * a viewer who may not edit) and its page's activity. Both load beside the
 * tree, so the fields show first.
 */
function OpenTask({
  driveId,
  pageId,
  taskId,
  taskTitle,
  taskHasDueDate,
  listPageId,
  agents,
  renderProps,
}: {
  readonly driveId: string;
  readonly pageId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly taskHasDueDate: boolean;
  readonly listPageId: string;
  readonly agents: readonly Assignee[];
  readonly renderProps: Omit<TaskDetailRenderProps, 'automations' | 'activity' | 'dueSetByImago'>;
}): ReactNode {
  const triggers = useTaskTriggers(taskId);
  const activity = usePageActivity(pageId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const feed = activity.activities ?? [];
  const automations =
    triggers.triggers === undefined || triggers.forbidden
      ? null
      : renderTaskAutomations({ rows: automationRows(triggers.triggers, agents), open: () => setDialogOpen(true) });
  return (
    <>
      {renderTaskDetail({
        ...renderProps,
        automations,
        activity: renderTaskActivity(activityRows(feed, new Date())),
        dueSetByImago: setByImago(feed, 'dueDate'),
      })}
      {triggers.triggers === undefined || triggers.forbidden ? null : (
        <TaskAgentTriggersDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          taskId={taskId}
          taskTitle={taskTitle}
          pageId={listPageId}
          driveId={driveId}
          hasDueDate={taskHasDueDate}
          onSaved={triggers.reload}
        />
      )}
    </>
  );
}
