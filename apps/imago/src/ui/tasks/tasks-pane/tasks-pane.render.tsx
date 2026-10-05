import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from '../../components/icon/icon';
import { ListGroup } from '../../components/list-group/list-group';
import { ProgressMeter } from '../../components/progress-meter/progress-meter';
import { renderEmptyState, renderErrorState } from '../../frame/edge-state/edge-state.render';
import type { Progress } from '../task-tree/task-tree';
import { taskListEmptyClass, taskListRowClass, taskListRowTitleClass, tasksPaneMessageClass } from './tasks-pane-class';

export type TasksPaneRenderProps =
  | { readonly state: 'loading' }
  | { readonly state: 'error'; readonly retry: () => void }
  | { readonly state: 'ready'; readonly rows: ReactNode; readonly empty: boolean };

/** The Tasks section's list: the drive's task lists, or why there are none. */
export function renderTasksPane(props: TasksPaneRenderProps): ReactNode {
  if (props.state === 'loading') {
    return (
      <p role="status" className={tasksPaneMessageClass}>
        Loading task lists…
      </p>
    );
  }
  if (props.state === 'error') return renderErrorState({ title: 'Could not load task lists', retry: props.retry });
  if (props.empty) return renderEmptyState({ title: 'No task lists yet', detail: 'Task lists in this drive show up here.' });
  return <ListGroup label="Task lists">{props.rows}</ListGroup>;
}

export type TaskListRowRenderProps = {
  readonly href: string;
  readonly title: string;
  readonly selected: boolean;
  /** Every loaded task in the list; absent until it loads. */
  readonly progress: Progress | undefined;
};

/** One list: a link to open it, with how much of it is done. */
export function renderTaskListRow({ href, title, selected, progress }: TaskListRowRenderProps): ReactNode {
  return (
    <li>
      <Link href={href} prefetch className={taskListRowClass(selected)} aria-current={selected ? 'page' : undefined}>
        <Icon name="tasks" />
        <span className={taskListRowTitleClass}>{title}</span>
        {progress === undefined ? null : progress.total === 0 ? (
          <span className={taskListEmptyClass}>No tasks</span>
        ) : (
          <ProgressMeter done={progress.done} total={progress.total} unit="tasks" />
        )}
      </Link>
    </li>
  );
}
