import Link from 'next/link';
import type { KeyboardEvent, ReactNode } from 'react';
import { AvatarGroup } from '../../components/avatar-group/avatar-group';
import { Checkbox } from '../../components/checkbox/checkbox';
import { Icon } from '../../components/icon/icon';
import { defaultStatuses } from '../task-model/from-api';
import type { Assignee, Priority, Task, TaskList, TaskListSummary } from '../task-model/task';
import { isPriority, priorities } from '../task-meta/task-meta';
import { isDone, progress } from '../task-tree/task-tree';
import { renderTreeView, type TaskNotice } from '../tree-view/tree-view.render';
import { dueDateFor, dueDay } from './due-date';
import {
  taskAssigneeOptionClass,
  taskAssigneesClass,
  taskAssigneesGroupClass,
  taskAssigneesMenuClass,
  taskAssigneesSummaryClass,
  taskClearClass,
  taskControlClass,
  taskDetailClass,
  taskDetailCrumbsClass,
  taskDetailMessageClass,
  taskDetailNoticeClass,
  taskDetailTitleClass,
  taskDetailTitleRowClass,
  taskFieldClass,
  taskFieldLabelClass,
  taskFieldValueClass,
  taskFieldsClass,
  taskSectionClass,
  taskSectionHeadingClass,
  taskUnassignedClass,
} from './task-detail-class';

/** The writes the detail makes, each a void action on the open task unless it names another. */
export type TaskDetailActions = {
  readonly rename: (title: string) => void;
  readonly toggleComplete: (taskId: string) => void;
  readonly setStatus: (slug: string) => void;
  readonly setPriority: (priority: Priority) => void;
  /** An instant to set, or null to clear. */
  readonly setDueDate: (dueDate: string | null) => void;
  readonly toggleAssignee: (assignee: Assignee) => void;
  readonly toggleExpanded: (taskId: string) => void;
  /** Adds a task to the list on `listPageId`; a refusal is shown at `at`. */
  readonly addTask: (listPageId: string, at: string, title: string) => void;
};

export type TaskDetailRenderProps = {
  /** The drive task list the task was opened from. */
  readonly holder: TaskListSummary;
  /** Every task from the top of that list down to the open one, which comes last. */
  readonly path: readonly Task[];
  /** The list holding the open task: its statuses apply. */
  readonly list: TaskList;
  /** Who can be put on the task; empty until the drive's members load. */
  readonly assignable: readonly Assignee[];
  readonly notice: TaskNotice | null;
  /** Which subtasks have their own subtasks open. */
  readonly expandedIds: readonly string[];
  /** Where a task's detail opens, and where a list's view does. */
  readonly hrefFor: (pageId: string) => string;
  /** The description's own slot: it loads and saves apart from the fields. */
  readonly description: ReactNode;
  readonly actions: TaskDetailActions;
};

const sameAssignee = (a: Assignee, b: Assignee): boolean => a.type === b.type && a.id === b.id;

const field = (label: string, control: ReactNode): ReactNode => (
  <div key={label} className={taskFieldClass}>
    <dt className={taskFieldLabelClass}>{label}</dt>
    <dd className={taskFieldValueClass}>{control}</dd>
  </div>
);

/* Text commits when it is left, not on every key: an edit is one change. A
   blank or unchanged title puts the old one back and sends nothing. */
const titleInput = (task: Task, rename: (title: string) => void): ReactNode => (
  <input
    key={`${task.id}:${task.title}`}
    aria-label="Title"
    defaultValue={task.title}
    className={taskDetailTitleClass}
    onBlur={(event) => {
      const value = event.currentTarget.value.trim();
      if (value === '' || value === task.title) {
        event.currentTarget.value = task.title;
        return;
      }
      rename(value);
    }}
    onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') event.currentTarget.value = task.title;
      if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur();
    }}
  />
);

/** Where the task sits: its list, then each task above it. */
const crumbs = ({ holder, path, hrefFor }: TaskDetailRenderProps): ReactNode => (
  <nav aria-label="Task path" className={taskDetailCrumbsClass}>
    {[{ pageId: holder.pageId, title: holder.title }, ...path.slice(0, -1)].map((step, index) => (
      <span key={step.pageId} className={taskFieldValueClass}>
        {index === 0 ? null : <Icon name="chevronRight" size={12} />}
        <Link href={hrefFor(step.pageId)} prefetch>
          {step.title}
        </Link>
      </span>
    ))}
  </nav>
);

/** The people and agents to offer: everyone assignable, plus anyone on the task who no longer is. */
const offered = (task: Task, assignable: readonly Assignee[]): readonly Assignee[] => [
  ...assignable,
  ...task.assignees.filter((entry) => !assignable.some((other) => sameAssignee(entry, other))),
];

const assigneePicker = (task: Task, props: TaskDetailRenderProps): ReactNode => {
  const everyone = offered(task, props.assignable);
  const agents = task.assignees.filter((entry) => entry.type === 'agent').map((entry) => entry.name);
  return (
    <details className={taskAssigneesClass}>
      <summary className={taskAssigneesSummaryClass}>
        {task.assignees.length === 0 ? (
          <span className={taskUnassignedClass}>Unassigned</span>
        ) : (
          <AvatarGroup names={task.assignees.map((entry) => entry.name)} agents={agents} label="Assigned to" />
        )}
        <Icon name="chevronDown" size={12} />
      </summary>
      <div className={taskAssigneesMenuClass}>
        {(['user', 'agent'] as const).map((type) => {
          const group = everyone.filter((entry) => entry.type === type);
          return group.length === 0 ? null : (
            <div key={type} className={taskFieldClass}>
              <p className={taskAssigneesGroupClass}>{type === 'user' ? 'Members' : 'Agents'}</p>
              {group.map((entry) => (
                <span key={`${entry.type}:${entry.id}`} className={taskAssigneeOptionClass}>
                  <Checkbox
                    checked={task.assignees.some((other) => sameAssignee(entry, other))}
                    label={`Assign ${entry.name}`}
                    toggle={() => props.actions.toggleAssignee(entry)}
                  />
                  {entry.name}
                </span>
              ))}
            </div>
          );
        })}
      </div>
    </details>
  );
};

/** PageSpace's fields for a task: status, priority, due date and assignees. */
const fields = (task: Task, props: TaskDetailRenderProps): ReactNode => {
  const { list, actions } = props;
  const statuses = list.statuses.length === 0 ? defaultStatuses : list.statuses;
  const day = dueDay(task.dueDate);
  return (
    <dl className={taskFieldsClass}>
      {field(
        'Status',
        <select
          aria-label="Status"
          className={taskControlClass}
          value={task.status}
          onChange={(event) => actions.setStatus(event.currentTarget.value)}
        >
          {statuses.map((status) => (
            <option key={status.slug} value={status.slug}>
              {status.name}
            </option>
          ))}
        </select>,
      )}
      {field(
        'Priority',
        <select
          aria-label="Priority"
          className={taskControlClass}
          value={task.priority}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (isPriority(value)) actions.setPriority(value);
          }}
        >
          {priorities.map((priority) => (
            <option key={priority.value} value={priority.value}>
              {priority.label}
            </option>
          ))}
        </select>,
      )}
      {field(
        'Due',
        <>
          <input
            type="date"
            aria-label="Due date"
            className={taskControlClass}
            value={day}
            onChange={(event) => actions.setDueDate(dueDateFor(event.currentTarget.value))}
          />
          {day === '' ? null : (
            <button
              type="button"
              aria-label="Clear due date"
              className={taskClearClass}
              onClick={() => actions.setDueDate(null)}
            >
              Clear
            </button>
          )}
        </>,
      )}
      {field('Assignees', assigneePicker(task, props))}
    </dl>
  );
};

/**
 * The task's subtasks as the Tree view's outline, starting a level below the
 * task: tick, open and add them in place. A task with none yet gets an empty
 * list on its own page, which is where the server puts its first subtask.
 */
const subtasks = (task: Task, props: TaskDetailRenderProps): ReactNode => {
  const below: TaskList = task.subtasks ?? {
    pageId: task.pageId,
    title: task.title,
    statuses: props.list.statuses,
    tasks: [],
    hasMore: false,
  };
  const { done, total } = progress(task);
  return (
    <section aria-label="Subtasks" className={taskSectionClass}>
      <h3 className={taskSectionHeadingClass}>{total === 0 ? 'Subtasks' : `Subtasks · ${done} of ${total}`}</h3>
      {renderTreeView({
        list: below,
        level: props.path.length,
        expandedIds: props.expandedIds,
        notice: props.notice,
        toggleExpanded: props.actions.toggleExpanded,
        toggleComplete: props.actions.toggleComplete,
        addTask: props.actions.addTask,
        taskHref: (entry) => props.hrefFor(entry.pageId),
        addLabel: 'Add subtask',
        addPlaceholder: 'Subtask title',
      })}
    </section>
  );
};

/**
 * A task opened as the object, every field edited where it sits: tick it,
 * rename it, set its status, priority, due date and people, describe it, and
 * work its subtasks. A refused edit says why under the title.
 */
export function renderTaskDetail(props: TaskDetailRenderProps): ReactNode {
  const task = props.path.at(-1);
  if (task === undefined) return null;
  const { list, notice, actions } = props;
  return (
    <article className={taskDetailClass} aria-label={task.title}>
      {crumbs(props)}
      <div className={taskDetailTitleRowClass}>
        <Checkbox
          checked={isDone(list, task)}
          label={`Complete ${task.title}`}
          toggle={() => actions.toggleComplete(task.id)}
        />
        {titleInput(task, actions.rename)}
      </div>
      {notice?.at === task.id ? (
        <p role="status" className={taskDetailNoticeClass}>
          {notice.message}
        </p>
      ) : null}
      {fields(task, props)}
      <section className={taskSectionClass}>
        <h3 className={taskSectionHeadingClass}>Description</h3>
        {props.description}
      </section>
      {subtasks(task, props)}
    </article>
  );
}

/** What the detail says while its task loads, if it fails, or if there is none. */
export function renderTaskDetailMessage(message: string, role: 'status' | 'alert'): ReactNode {
  return (
    <p role={role} className={taskDetailMessageClass}>
      {message}
    </p>
  );
}
