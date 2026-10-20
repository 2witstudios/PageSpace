import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from '../../components/icon/icon';
import { renderIconButton } from '../../components/icon-button/icon-button.render';
import { ListGroup } from '../../components/list-group/list-group';
import { renderEmptyState, renderErrorState } from '../../frame/edge-state/edge-state.render';
import type { Progress } from '../task-tree/task-tree';
import type { TaskViewId } from '../task-views/task-views';
import type { GroundRow } from '../tasks-ground/ground-rows';
import { dueClass } from '../tasks-ground/tasks-ground-class';
import {
  taskListBarClass,
  taskListCountClass,
  taskListEmptyClass,
  taskListHeadClass,
  taskListMetaClass,
  taskListRowClass,
  taskListRowTitleClass,
  taskViewClass,
  taskViewCountClass,
  taskViewDotClass,
  taskGlanceMoreClass,
  taskGlanceRowClass,
  tasksPaneLabelClass,
  tasksPaneMessageClass,
} from './tasks-pane-class';

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

export type TaskViewRenderProps = {
  readonly id: TaskViewId;
  readonly label: string;
  readonly dotClass: string;
  readonly warn: boolean;
  /** undefined while the counts load. */
  readonly count: number | undefined;
  readonly selected: boolean;
  /** Opens the view's tasks in the middle. */
  readonly href: string;
};

/** The Tasks head's + : an untitled list at the drive's top, opened so it can be renamed. */
export function renderNewListButton(onNew: () => void): ReactNode {
  return renderIconButton({ name: 'plus', label: 'New list', onClick: onNew });
}

/** The smart views, each with its count; picking one opens its tasks in the middle. */
export function renderTaskViews({ views }: { readonly views: readonly TaskViewRenderProps[] }): ReactNode {
  return (
    <section aria-label="Views" className="flex flex-col gap-1">
      <p className={tasksPaneLabelClass}>Views</p>
      {views.map((view) => {
        const warn = view.warn && view.count !== undefined && view.count > 0;
        return (
          <Link
            key={view.id}
            href={view.href}
            prefetch
            aria-current={view.selected ? 'page' : undefined}
            className={taskViewClass(view.selected)}
          >
            <span aria-hidden="true" className={taskViewDotClass(view.dotClass)} />
            <span className="min-w-0 flex-1 truncate">{view.label}</span>
            <span className={taskViewCountClass(warn)}>{view.count ?? ''}</span>
          </Link>
        );
      })}
    </section>
  );
}

export type TaskGlanceRenderProps = {
  /** The overdue and due-this-week tasks to show; undefined while they load. */
  readonly rows: readonly GroundRow[] | undefined;
  /** How many more are due than the rows shown; See all shows only when there are some. */
  readonly more: number;
  /** Where See all goes: the view that holds every one of them. */
  readonly moreHref: string;
};

/**
 * Needs attention: the viewer's overdue and due-this-week tasks at a glance, so the pane is
 * useful beside the chat before anything opens. Each row opens its task; nothing shows when
 * nothing is due.
 */
export function renderTaskGlance({ rows, more, moreHref }: TaskGlanceRenderProps): ReactNode {
  if (rows === undefined || rows.length === 0) return null;
  return (
    <section aria-label="Needs attention" className="flex flex-col gap-px pt-3">
      <p className={tasksPaneLabelClass}>Needs attention</p>
      <ul className="flex flex-col gap-px">
        {rows.map((row) => (
          <li key={row.id}>
            <Link
              href={`/${encodeURIComponent(row.driveId)}/tasks/${encodeURIComponent(row.pageId)}`}
              prefetch
              className={taskGlanceRowClass}
            >
              <span className="min-w-0 flex-1 truncate">{row.title}</span>
              <span className={dueClass(row.dueTone)}>{row.due}</span>
            </Link>
          </li>
        ))}
      </ul>
      {more > 0 ? (
        <Link href={moreHref} prefetch className={taskGlanceMoreClass}>
          See all
        </Link>
      ) : null}
    </section>
  );
}

export type TaskListRowRenderProps = {
  readonly href: string;
  readonly title: string;
  readonly selected: boolean;
  /** Every loaded task in the list; absent until it loads. */
  readonly progress: Progress | undefined;
  /** The list's meta line; empty when nothing counts. */
  readonly meta: string;
};

/** One list: a link to open it, with how much of it is done and what needs attention. */
export function renderTaskListRow({ href, title, selected, progress, meta }: TaskListRowRenderProps): ReactNode {
  return (
    <li>
      <Link href={href} prefetch className={taskListRowClass(selected)} aria-current={selected ? 'page' : undefined}>
        <span className={taskListHeadClass}>
          <Icon name="tasks" />
          <span className={taskListRowTitleClass}>{title}</span>
          {progress === undefined ? null : progress.total === 0 ? (
            <span className={taskListEmptyClass}>No tasks</span>
          ) : (
            <span className={taskListCountClass}>{`${progress.done}/${progress.total}`}</span>
          )}
        </span>
        {progress === undefined || progress.total === 0 ? null : (
          <progress
            role="progressbar"
            className={taskListBarClass}
            value={progress.done}
            max={progress.total}
            aria-label={`${title}: ${progress.done} of ${progress.total} tasks done`}
          />
        )}
        {meta === '' ? null : <span className={taskListMetaClass}>{meta}</span>}
      </Link>
    </li>
  );
}
