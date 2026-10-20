'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { edgeOf, renderErrorState } from '../../frame/edge-state/edge-state.render';
import { TASK_LIST_NOT_FOUND, renderNotFound } from '../../frame/not-found/not-found.render';
import { useUiState } from '../../store/store';
import type { UiState } from '../../store/state';
import { dispatch, transactions } from '../../store/transactions';
import { BoardView } from '../board-view/board-view';
import { FocusView } from '../focus-view/focus-view';
import { RoadmapView } from '../roadmap-view/roadmap-view';
import { TaskDescription } from '../task-description/task-description';
import { chipCounts, filterTree, isFiltering, openedForMatches, type TaskChip } from '../task-filter/task-filter';
import type { Task, TaskList } from '../task-model/task';
import { localToday } from '../task-meta/task-meta';
import { taskHref } from '../task-object/task-route';
import { TaskTreeRealtime } from '../task-realtime/task-realtime';
import { listProgress } from '../task-tree/task-tree';
import { useTaskView } from '../task-view/use-task-view';
import type { TaskViewName } from '../task-view/task-view';
import { TreeView } from '../tree-view/tree-view';
import { useDriveTaskLists, usePageEditable, useTaskList, type TaskActions } from '../use-tasks/use-tasks';
import { TaskListTools } from './task-list-tools';
import { taskListEmptyClass } from './task-list-view-class';
import {
  renderTaskListDescription,
  renderTaskListMessage,
  renderTaskListStrip,
  renderTaskListView,
} from './task-list-view.render';

export type TaskListViewProps = {
  readonly driveId: string;
  /** The TASK_LIST page the route opened. */
  readonly pageId: string;
  /** Whose view choice to restore and save, and whose tasks Mine means. */
  readonly viewerId: string;
  /**
   * The page's own title, when the caller has it: a task's own page opened
   * from Files is a list of its subtasks, not one of the drive's lists.
   */
  readonly title?: string;
  /** What "today" is for Done today and due dates; the machine's clock unless a test injects one. */
  readonly clock?: () => Date;
  /** Whether to keep the tree current with other people's edits; tests mount without a socket. */
  readonly live?: boolean;
};

const selectExpanded = (state: UiState) => state.resources.expandedTasks;

const systemClock = (): Date => new Date();

/** The visible label of the add control each view ends in, which + Task opens. */
const addLabels: Readonly<Record<TaskViewName, ((title: string) => string) | null>> = {
  tree: () => 'Add task',
  focus: (title) => `Add task to ${title}`,
  board: () => 'New card',
  roadmap: null,
};

type Body = {
  readonly driveId: string;
  /** The list before the strip's filter. */
  readonly fullList: TaskList;
  readonly viewerId: string;
  readonly list: TaskList;
  readonly view: TaskViewName;
  readonly filtering: boolean;
  readonly expandedIds: readonly string[];
  readonly actions: TaskActions;
  readonly editable: boolean;
  readonly clock: () => Date;
};

const bodyFor = ({ driveId, fullList, list, view, filtering, expandedIds, actions, editable, clock }: Body): ReactNode => {
  const href = (task: Task) => taskHref(driveId, task.pageId);
  const toggleExpanded = (taskId: string) => dispatch(transactions.toggleTaskExpanded, taskId);
  const today = localToday(clock());
  if (filtering && list.tasks.length === 0) {
    return <p className={taskListEmptyClass}>No tasks match this filter.</p>;
  }
  switch (view) {
    case 'board':
      return (
        <BoardView
          list={list}
          fullList={fullList}
          actions={actions}
          today={today}
          editable={editable}
          reorderable={!filtering}
          expandedIds={expandedIds}
          toggleExpanded={toggleExpanded}
          taskHref={href}
        />
      );
    case 'roadmap':
      return <RoadmapView list={list} actions={actions} today={today} editable={editable} taskHref={href} />;
    case 'focus':
      return <FocusView driveId={driveId} list={list} actions={actions} clock={clock} editable={editable} taskHref={href} />;
    case 'tree':
      return (
        <TreeView
          list={list}
          actions={actions}
          expandedIds={expandedIds}
          toggleExpanded={toggleExpanded}
          today={today}
          editable={editable}
          reorderable={!filtering}
          taskHref={href}
        />
      );
  }
};

/**
 * A drive's task list in the object slot: the List controls strip over the
 * chosen view. The tree, its writes and their refusals come from
 * useTaskList over the real task routes; the strip's chips and search
 * narrow what every view shows; the view choice and which tasks are open
 * are store resources.
 */
export function TaskListView({ driveId, pageId, viewerId, title: pageTitle, clock = systemClock, live = true }: TaskListViewProps) {
  const { lists } = useDriveTaskLists(driveId);
  const entry = lists?.find((candidate) => candidate.pageId === pageId);
  const title = entry?.title ?? pageTitle ?? '';
  const { list, error, actions, retry } = useTaskList(pageId, title);
  // Capture, add rows, menus and drags wait for a definite yes.
  const editable = usePageEditable(pageId) === true;
  const [view, switchView] = useTaskView(viewerId);
  const storedExpanded = useUiState(selectExpanded);
  const [chip, setChip] = useState<TaskChip>('all');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  const today = localToday(clock());
  const filter = useMemo(() => ({ chip, query }), [chip, query]);
  const filtering = isFiltering(filter);
  const shown = useMemo(
    () => (list === undefined ? undefined : filterTree(list, filter, { viewerId, today })),
    [list, filter, viewerId, today],
  );
  const counts = useMemo(() => (list === undefined ? undefined : chipCounts(list, { viewerId, today })), [list, viewerId, today]);
  // While a filter is on, every parent kept for a match below it is open, so the match shows.
  const expandedIds = useMemo(
    () => (filtering && shown !== undefined ? [...new Set([...storedExpanded, ...openedForMatches(shown)])] : storedExpanded),
    [filtering, shown, storedExpanded],
  );

  // The drive's lists are the authority on which ids are its task lists; a
  // refused or unknown id says the same, so it never tells which it was. A
  // caller that names the page itself (a task's page opened from Files) is
  // trusted to have read it.
  const unknown = pageTitle === undefined && lists !== undefined && entry === undefined;
  if (unknown || (error !== undefined && edgeOf(error) === 'not-found')) {
    return renderNotFound({
      ...TASK_LIST_NOT_FOUND,
      homeHref: `/${encodeURIComponent(driveId)}/tasks`,
      linkLabel: 'Back to Tasks',
    });
  }
  if (list === undefined && error !== undefined) {
    return renderErrorState({ title: 'Could not load this task list', retry });
  }

  const label = addLabels[view];
  const addTask =
    editable && label !== null
      ? () => {
          const text = label(title);
          const control = [...(body.current?.querySelectorAll('button') ?? [])].find(
            (button) => button.textContent?.trim() === text,
          );
          control?.scrollIntoView({ block: 'nearest' });
          control?.click();
        }
      : undefined;

  const stripControls = renderTaskListStrip({
    view,
    switchView,
    chip,
    selectChip: setChip,
    counts,
    query,
    typeQuery: setQuery,
    searching: searchOpen || query !== '',
    openSearch: () => {
      setSearchOpen(true);
      // The field mounts on this render; the caret goes in once it is there.
      requestAnimationFrame(() => strip.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus());
    },
    closeSearch: () => setSearchOpen(false),
    progress: list === undefined ? undefined : listProgress(list),
    tools: (
      <TaskListTools
        driveId={driveId}
        pageId={pageId}
        title={title}
        statuses={list?.statuses ?? []}
        editable={editable}
        revalidate={retry}
      />
    ),
    addTask,
  });

  return (
    <>
      {live ? <TaskTreeRealtime rootPageId={pageId} tree={list} /> : null}
      {renderTaskListView({
        strip: <div ref={strip} className="contents">{stripControls}</div>,
        wide: view === 'board' || view === 'roadmap',
        bodyRef: body,
        description:
          view === 'tree' || view === 'focus'
            ? renderTaskListDescription({
                open: descriptionOpen,
                toggle: () => setDescriptionOpen((open) => !open),
                editor: <TaskDescription pageId={pageId} />,
              })
            : null,
        body:
          shown === undefined
            ? renderTaskListMessage('Loading tasks…', 'status')
            : bodyFor({ driveId, viewerId, fullList: list ?? shown, list: shown, view, filtering, expandedIds, actions, editable, clock }),
      })}
    </>
  );
}
