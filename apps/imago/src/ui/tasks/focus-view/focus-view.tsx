'use client';

// The Focus view bound to its data. "This list" is the open list's frontier,
// read from the tree the other views share; "All lists" is the viewer's own
// open leaves across the drive, from every page of GET /api/tasks, grouped
// by the list each sits in, and ticked off through that list's own statuses.
// Ticking follows the open list's edit permission in "This list". In "All
// lists" the rows come from lists whose permissions this tab never read (the
// route carries none), so ticking stays on there: the server decides, and a
// refusal rolls the row back under the notice.

import { useState, type ReactNode } from 'react';
import { SegmentedControl } from '../../components/segmented-control/segmented-control';
import { statusesFrom, taskFromItem } from '../task-model/from-api';
import type { DriveTasksResponse, Task, TaskList } from '../task-model/task';
import { localToday } from '../task-meta/task-meta';
import type { TaskNotice } from '../tree-view/tree-view.render';
import { useDriveTasks, type ActionResult, type TaskActions } from '../use-tasks/use-tasks';
import { doneToday, frontier, type FocusGroup } from './focus';
import { renderFocusView } from './focus-view.render';
import { focusScopeClass } from './focus-view-class';

export type FocusScope = 'list' | 'drive';

const scopes = [
  { value: 'list' as const, label: 'This list' },
  { value: 'drive' as const, label: 'All lists' },
];

export type FocusViewProps = {
  readonly driveId: string;
  /** The open list, already narrowed by the strip. */
  readonly list: TaskList;
  readonly actions: TaskActions;
  readonly clock: () => Date;
  readonly editable: boolean;
  readonly taskHref?: (task: Task) => string;
};

const UNDATED = '9999-12-31';

const earliest = (group: FocusGroup): string =>
  group.tasks
    .map((task) => task.dueDate?.slice(0, 10))
    .filter((due): due is string => due !== undefined)
    .sort()[0] ?? UNDATED;

/**
 * The viewer's open leaves across the drive, one group per list, soonest
 * due first. A row the server counts subtasks for is a parent, not a next
 * step; a row from before the counts existed is taken as a leaf.
 */
export const driveFrontier = (response: DriveTasksResponse): readonly FocusGroup[] => {
  const byList = new Map<string, FocusGroup>();
  for (const row of response.tasks) {
    if ((row.subTaskCount ?? 0) > 0 || row.statusGroup === 'done') continue;
    const existing = byList.get(row.taskListPageId);
    const task = taskFromItem(row);
    if (existing !== undefined) {
      byList.set(row.taskListPageId, { ...existing, tasks: [...existing.tasks, task] });
      continue;
    }
    const list: TaskList = {
      pageId: row.taskListPageId,
      title: row.taskListPageTitle,
      statuses: statusesFrom(response.statusConfigsByTaskList?.[row.taskListPageId] ?? []),
      tasks: [],
      hasMore: false,
    };
    byList.set(row.taskListPageId, { id: row.taskListPageId, heading: row.taskListPageTitle, list, parent: null, tasks: [task] });
  }
  return [...byList.values()].sort((a, b) => earliest(a).localeCompare(earliest(b)));
};

type Shared = {
  readonly notice: TaskNotice | null;
  readonly report: (at: string) => (result: ActionResult) => void;
  readonly expandedGroups: readonly string[];
  readonly toggleGroup: (groupId: string) => void;
};

function DriveFocus({ driveId, list, clock, taskHref, shared }: FocusViewProps & { readonly shared: Shared }): ReactNode {
  const { response, error, retry, toggleComplete } = useDriveTasks(driveId, 'active', undefined, 'every');
  if (response === undefined) {
    return error === undefined ? (
      <p role="status" className="text-sm text-ink-muted">
        Loading your tasks…
      </p>
    ) : (
      <p role="alert" className="text-sm text-ink-muted">
        Could not load your tasks.{' '}
        <button type="button" className="cursor-pointer font-medium text-accent-deep" onClick={retry}>
          Try again
        </button>
      </p>
    );
  }
  const { hasMore, total } = response.pagination;
  const focus = renderFocusView({
    title: list.title,
    listPageId: list.pageId,
    groups: driveFrontier(response),
    done: null,
    notice: shared.notice,
    today: localToday(clock()),
    taskHref,
    expandedGroups: shared.expandedGroups,
    toggleGroup: shared.toggleGroup,
    toggleComplete: (taskId) => {
      void toggleComplete(taskId).then(shared.report(taskId));
    },
  });
  // Past the read's cap the frontier is the most recently updated rows only; it says so.
  return hasMore ? (
    <>
      <p role="status" data-truncated="" className="text-sm text-ink-muted">
        {`Showing your ${response.tasks.length} most recently updated tasks of ${total}.`}
      </p>
      {focus}
    </>
  ) : (
    focus
  );
}

/**
 * The Focus view with its scope switch: the open list's frontier, or the
 * viewer's own across every list of the drive.
 */
export function FocusView(props: FocusViewProps): ReactNode {
  const { list, actions, clock, editable, taskHref } = props;
  const [scope, setScope] = useState<FocusScope>('list');
  const [notice, setNotice] = useState<TaskNotice | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<readonly string[]>([]);
  const [doneOpen, setDoneOpen] = useState(true);
  const shared: Shared = {
    notice,
    report: (at) => (result) => setNotice(result.ok ? null : { at, message: result.refusal }),
    expandedGroups,
    toggleGroup: (groupId) =>
      setExpandedGroups((open) => (open.includes(groupId) ? open.filter((id) => id !== groupId) : [...open, groupId])),
  };
  return (
    <div className="flex flex-col gap-4">
      <div className={focusScopeClass}>
        <SegmentedControl label="Scope" segments={scopes} value={scope} select={setScope} />
      </div>
      {scope === 'drive' ? (
        <DriveFocus {...props} shared={shared} />
      ) : (
        renderFocusView({
          title: list.title,
          listPageId: list.pageId,
          groups: frontier(list),
          done: doneToday(list, clock()),
          notice,
          today: localToday(clock()),
          taskHref,
          expandedGroups,
          toggleGroup: shared.toggleGroup,
          doneOpen,
          toggleDone: () => setDoneOpen((open) => !open),
          toggleComplete: editable
            ? (taskId) => {
                void actions.toggleComplete(taskId).then(shared.report(taskId));
              }
            : undefined,
          capture: editable
            ? (title) => {
                void actions.create(list.pageId, { title }).then(shared.report(list.pageId));
              }
            : undefined,
        })
      )}
    </div>
  );
}
