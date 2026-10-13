import type { ReactNode } from 'react';
import { ProgressMeter } from '../../components/progress-meter/progress-meter';
import { SegmentedControl } from '../../components/segmented-control/segmented-control';
import type { Progress } from '../task-tree/task-tree';
import { taskViews, type TaskViewName } from '../task-view/task-view';
import {
  taskListBodyClass,
  taskListMessageClass,
  taskListTitleClass,
  taskListToolbarClass,
  taskListViewClass,
} from './task-list-view-class';

export type TaskListViewRenderProps = {
  /** The list's page title; empty until the drive's lists load. */
  readonly title: string;
  /** Every loaded task, done and in all; absent until the list loads. */
  readonly progress: Progress | undefined;
  readonly view: TaskViewName;
  /** Void action: switches the view and saves the choice. */
  readonly switchView: (view: TaskViewName) => void;
  /** The chosen view's body, or the list's loading or error message. */
  readonly body: ReactNode;
};

/**
 * A task list opened as the object: its title, its progress and the
 * canvases' Focus | Tree | Board switch, then the chosen view.
 */
export function renderTaskListView({ title, progress, view, switchView, body }: TaskListViewRenderProps): ReactNode {
  return (
    <div className={taskListViewClass}>
      <div className={taskListToolbarClass}>
        <h2 className={taskListTitleClass}>{title}</h2>
        {progress === undefined || progress.total === 0 ? null : (
          <ProgressMeter done={progress.done} total={progress.total} unit="tasks" />
        )}
        <SegmentedControl label="View" segments={taskViews} value={view} select={switchView} />
      </div>
      <div className={taskListBodyClass}>{body}</div>
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
