import type { ReactNode, RefObject } from 'react';
import { Icon } from '../../components/icon/icon';
import { IconButton } from '../../components/icon-button/icon-button';
import { ProgressMeter } from '../../components/progress-meter/progress-meter';
import { SearchInput } from '../../components/search-input/search-input';
import { SegmentedControl } from '../../components/segmented-control/segmented-control';
import { ToolbarStrip } from '../../frame/toolbar-strip/toolbar-strip';
import type { ChipCounts, TaskChip } from '../task-filter/task-filter';
import type { Progress } from '../task-tree/task-tree';
import { taskViews, type TaskViewName } from '../task-view/task-view';
import {
  taskListBodyClass,
  taskListColumnClass,
  taskListDescriptionClass,
  taskListDescriptionToggleClass,
  taskListMessageClass,
  taskListViewClass,
  taskStripDividerClass,
  taskStripPrimaryClass,
  taskStripRowClass,
  taskStripSearchClass,
} from './task-list-view-class';

export type TaskListStripProps = {
  readonly view: TaskViewName;
  /** Void action: switches the view and saves the choice. */
  readonly switchView: (view: TaskViewName) => void;
  readonly chip: TaskChip;
  readonly selectChip: (chip: TaskChip) => void;
  /** Undefined until the list loads. */
  readonly counts: ChipCounts | undefined;
  readonly query: string;
  readonly typeQuery: (query: string) => void;
  /** The filter field is out; folded to its icon otherwise, so a narrow middle keeps every control. */
  readonly searching: boolean;
  /** Void action: opens the filter field and puts the caret in it. */
  readonly openSearch: () => void;
  /** Void action: folds an empty filter field back to its icon. */
  readonly closeSearch: () => void;
  /** Every loaded task, done and in all; absent until the list loads. */
  readonly progress: Progress | undefined;
  /** Statuses and Workflows, for the viewers who may use them. */
  readonly tools: ReactNode;
  /** + Task, for a viewer who may add; absent in a view with nowhere to add. */
  readonly addTask?: () => void;
};

const chips = (counts: ChipCounts | undefined) => [
  { value: 'all' as const, label: 'All', count: counts?.all },
  { value: 'mine' as const, label: 'Mine', count: counts?.mine },
  { value: 'overdue' as const, label: 'Overdue', count: counts?.overdue },
];

/**
 * The 44px List controls strip (C-Tasks-Tree): the Focus | Tree | Board |
 * Roadmap switch, the All / Mine / Overdue chips with their counts and the
 * filter box; at its end the list's progress, Statuses, Workflows and + Task.
 */
export function renderTaskListStrip(props: TaskListStripProps): ReactNode {
  return (
    <ToolbarStrip label="List controls">
      <div className={taskStripRowClass}>
        <SegmentedControl label="View" segments={taskViews} value={props.view} select={props.switchView} />
        <span aria-hidden="true" className={taskStripDividerClass} />
        <SegmentedControl label="Show" segments={chips(props.counts)} value={props.chip} select={props.selectChip} />
        {props.searching ? (
          <div
            className={taskStripSearchClass}
            onBlur={(event) => {
              if (props.query === '' && !event.currentTarget.contains(event.relatedTarget)) props.closeSearch();
            }}
          >
            <SearchInput value={props.query} placeholder="Filter tasks" label="Filter tasks" typeSearchQuery={props.typeQuery} />
          </div>
        ) : (
          <IconButton name="search" label="Filter tasks" onClick={props.openSearch} />
        )}
        <div className="flex-1" />
        {props.progress === undefined || props.progress.total === 0 ? null : (
          <ProgressMeter done={props.progress.done} total={props.progress.total} unit="tasks" />
        )}
        {props.tools}
        {props.addTask === undefined ? null : (
          <button type="button" className={taskStripPrimaryClass} onClick={props.addTask}>
            <Icon name="plus" size={14} />
            Task
          </button>
        )}
      </div>
    </ToolbarStrip>
  );
}

export type TaskListDescriptionProps = {
  readonly open: boolean;
  readonly toggle: () => void;
  /** The editor, drawn only while open so a folded description loads nothing. */
  readonly editor: ReactNode;
};

/** The list's own page content (classic's Editor mode), folded above the outline. */
export function renderTaskListDescription({ open, toggle, editor }: TaskListDescriptionProps): ReactNode {
  return (
    <section aria-label="List description" className={taskListDescriptionClass}>
      <button type="button" aria-expanded={open} className={taskListDescriptionToggleClass(open)} onClick={toggle}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        Description
      </button>
      {open ? editor : null}
    </section>
  );
}

export type TaskListViewRenderProps = {
  readonly strip: ReactNode;
  /** The Board and the Roadmap take the whole width; the outline views read in a column. */
  readonly wide: boolean;
  /** Drawn above an outline view's body. */
  readonly description: ReactNode;
  /** The chosen view's body, or the list's loading or error message. */
  readonly body: ReactNode;
  readonly bodyRef?: RefObject<HTMLDivElement | null>;
};

/** A task list opened as the object: its strip, then the chosen view. */
export function renderTaskListView({ strip, wide, description, body, bodyRef }: TaskListViewRenderProps): ReactNode {
  return (
    <div className={taskListViewClass}>
      {strip}
      <div ref={bodyRef} className={taskListBodyClass(wide)}>
        {wide ? (
          body
        ) : (
          <div className={taskListColumnClass}>
            {description}
            {body}
          </div>
        )}
      </div>
    </div>
  );
}

/** What the body says while the list loads, if it fails, or for a view still to come. */
export function renderTaskListMessage(message: string, role: 'status' | 'alert'): ReactNode {
  return (
    <p role={role} className={taskListMessageClass}>
      {message}
    </p>
  );
}
