import Link from 'next/link';
import type { KeyboardEvent, ReactNode } from 'react';
import { AvatarGroup } from '../../components/avatar-group/avatar-group';
import { Checkbox } from '../../components/checkbox/checkbox';
import { shortDayLabel } from '../../components/date-picker/calendar';
import { DatePicker } from '../../components/date-picker/date-picker';
import { Icon } from '../../components/icon/icon';
import { ChoiceMenu } from '../../components/popover/menu';
import { Popover } from '../../components/popover/popover';
import { ToolbarStrip } from '../../frame/toolbar-strip/toolbar-strip';
import { defaultStatuses } from '../task-model/from-api';
import type { Assignee, Priority, Task, TaskList, TaskListSummary, TaskStatus } from '../task-model/task';
import { dueToneOf, isPriority, priorities } from '../task-meta/task-meta';
import { isDone, progress } from '../task-tree/task-tree';
import { renderTreeView, type TaskNotice } from '../tree-view/tree-view.render';
import { AssigneePicker, sameAssignee } from './assignee-picker';
import { dueDateFor, dueDay } from './due-date';
import {
  taskChipClass,
  taskChipEmptyClass,
  taskChipReadOnlyClass,
  taskChipReadOnlyEmptyClass,
  taskConfirmActionsClass,
  taskConfirmCancelClass,
  taskConfirmClass,
  taskConfirmDeleteClass,
  taskDetailClass,
  taskDetailCrumbsClass,
  taskDetailMessageClass,
  taskDetailNoticeClass,
  taskDetailTitleClass,
  taskCrumbCurrentClass,
  taskDetailTitleRowClass,
  taskDueChipClass,
  taskFieldValueClass,
  taskFieldsClass,
  taskHintClass,
  taskPriorityBarClass,
  taskPriorityClass,
  taskSavedClass,
  taskSectionClass,
  taskSectionHeadingClass,
  taskStatusDotClass,
  taskStatusPillClass,
  taskStripButtonClass,
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
  /** When work is planned to begin: an instant to set, or null to clear. */
  readonly setStartDate: (startDate: string | null) => void;
  readonly toggleAssignee: (assignee: Assignee) => void;
  readonly toggleExpanded: (taskId: string) => void;
  /** Adds a task to the list on `listPageId`; a refusal is shown at `at`. */
  readonly addTask: (listPageId: string, at: string, title: string) => void;
  /** Deletes the open task and its subtasks; the detail then leaves for its list. */
  readonly remove: () => void;
};

export type TaskDetailRenderProps = {
  readonly driveId: string;
  /** The drive task list the task was opened from. */
  readonly holder: TaskListSummary;
  /** Every task from the top of that list down to the open one, which comes last. */
  readonly path: readonly Task[];
  /** The list holding the open task: its statuses apply. */
  readonly list: TaskList;
  /** Who can be put on the task; empty until the drive's members load. */
  readonly assignable: readonly Assignee[];
  readonly notice: TaskNotice | null;
  /** The task before and after this one in its list's order, as the pages they open. */
  readonly previousHref: string | null;
  readonly nextHref: string | null;
  /** Whether Imago last set the due date: the Due row says so. */
  readonly dueSetByImago: boolean;
  /** The viewer's own day, YYYY-MM-DD: what the date chips and pickers read against. */
  readonly today: string;
  /** Whether the viewer may edit the list: without it every field reads as text, and nothing writes. */
  readonly canEdit: boolean;
  /** Which subtasks have their own subtasks open. */
  readonly expandedIds: readonly string[];
  /** Where a task's detail opens, and where a list's view does. */
  readonly hrefFor: (pageId: string) => string;
  /** The description's own slot: it loads and saves apart from the fields. */
  readonly description: ReactNode;
  /** The Automations section, or null when the viewer may not see it. */
  readonly automations: ReactNode | null;
  /** The Activity section, below the subtasks. */
  readonly activity: ReactNode;
  readonly actions: TaskDetailActions;
};

/* Text commits when it is left, not on every key: an edit is one change. A
   blank or unchanged title puts the old one back and sends nothing. A viewer
   who may not edit reads it as the heading it is. */
const titleInput = (task: Task, rename: (title: string) => void, canEdit: boolean): ReactNode => {
  if (!canEdit) return <h2 className={taskDetailTitleClass}>{task.title}</h2>;
  return (
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
};

/** Where the task sits: Tasks, its list, each task above it, then the task itself. */
const crumbs = ({ driveId, holder, path, hrefFor }: TaskDetailRenderProps): ReactNode => {
  const task = path.at(-1);
  return (
    <nav aria-label="Task path" className={taskDetailCrumbsClass}>
      <span className={taskFieldValueClass}>
        <Link href={`/${encodeURIComponent(driveId)}/tasks`} prefetch>
          Tasks
        </Link>
      </span>
      {[{ pageId: holder.pageId, title: holder.title }, ...path.slice(0, -1)].map((step) => (
        <span key={step.pageId} className={taskFieldValueClass}>
          <Icon name="chevronRight" size={12} />
          <Link href={hrefFor(step.pageId)} prefetch>
            {step.title}
          </Link>
        </span>
      ))}
      {task === undefined ? null : (
        <span className={taskFieldValueClass}>
          <Icon name="chevronRight" size={12} />
          <span aria-current="page" className={taskCrumbCurrentClass}>
            {task.title}
          </span>
        </span>
      )}
    </nav>
  );
};

const TaskStep = ({
  href,
  label,
  icon,
}: {
  readonly href: string | null;
  readonly label: string;
  readonly icon: 'chevronLeft' | 'chevronRight';
}): ReactNode =>
  href === null ? (
    <button type="button" aria-label={label} disabled className={taskStripButtonClass}>
      <Icon name={icon} size={15} />
    </button>
  ) : (
    <Link href={href} prefetch aria-label={label} title={label} className={taskStripButtonClass}>
      <Icon name={icon} size={15} />
    </Link>
  );

/** Delete, confirmed in a small popover: the task goes with every subtask under it. */
const deleteButton = (remove: () => void): ReactNode => (
  <Popover
    label="Delete task"
    align="end"
    width="auto"
    trigger={
      <button type="button" aria-label="Delete task" title="Delete task" className={taskStripButtonClass}>
        <Icon name="trash" size={15} />
      </button>
    }
  >
    {(close) => (
      <div className={taskConfirmClass}>
        <p>Delete this task and its subtasks?</p>
        <div className={taskConfirmActionsClass}>
          <button type="button" className={taskConfirmCancelClass} onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className={taskConfirmDeleteClass}
            onClick={() => {
              close();
              remove();
            }}
          >
            Delete
          </button>
        </div>
      </div>
    )}
  </Popover>
);

/** The 44px strip: the task before and after in list order, and whether the last edit was saved. */
const strip = (props: TaskDetailRenderProps): ReactNode => (
  <ToolbarStrip label="Task">
    <TaskStep href={props.previousHref} label="Previous task" icon="chevronLeft" />
    <TaskStep href={props.nextHref} label="Next task" icon="chevronRight" />
    <div className="flex-1" />
    <span className={taskSavedClass}>
      {props.notice === null ? 'Saved' : 'Not saved'}
    </span>
    {props.canEdit ? deleteButton(props.actions.remove) : null}
  </ToolbarStrip>
);

/** The people and agents to offer: everyone assignable, plus anyone on the task who no longer is. */
const offered = (task: Task, assignable: readonly Assignee[]): readonly Assignee[] => [
  ...assignable,
  ...task.assignees.filter((entry) => !assignable.some((other) => sameAssignee(entry, other))),
];

const PRIORITY_BARS = [4, 8, 12] as const;

/** The priority as three bars, as the Tasks ground draws it. */
const priorityGlyph = (priority: Priority): ReactNode => {
  const level = priority === 'high' ? 3 : priority === 'medium' ? 2 : 1;
  return (
    <span aria-hidden="true" className={taskPriorityClass}>
      {PRIORITY_BARS.map((height, index) => (
        <span key={height} className={taskPriorityBarClass(index < level, height, priority)} />
      ))}
    </span>
  );
};

const statusDot = (status: TaskStatus): ReactNode => (
  <span aria-hidden="true" className={taskStatusDotClass(status.group)} />
);

type DateFieldProps = {
  readonly name: 'Due' | 'Start';
  /** The stored instant, or null for none. */
  readonly value: string | null;
  readonly today: string;
  readonly min?: string;
  readonly max?: string;
  readonly className: string;
  /** Absent for a viewer who may not edit: the chip only reads. */
  readonly set?: (instant: string | null) => void;
};

/** A date as a chip ("Due · Fri 23", or "Set due date"), opening the picker; a pick saves and closes. */
const dateField = ({ name, value, today, min, max, className, set }: DateFieldProps): ReactNode => {
  const day = dueDay(value);
  const label = `${name} date`;
  if (set === undefined) {
    return (
      <span className={day === '' ? taskChipReadOnlyEmptyClass : className}>
        <Icon name="calendar" size={14} />
        {day === '' ? `No ${label.toLowerCase()}` : `${name} · ${shortDayLabel(day, today)}`}
      </span>
    );
  }
  return (
    <Popover
      label={label}
      trigger={
        <button type="button" className={day === '' ? taskChipEmptyClass : className}>
          <Icon name="calendar" size={14} />
          {day === '' ? `Set ${label.toLowerCase()}` : `${name} · ${shortDayLabel(day, today)}`}
        </button>
      }
    >
      {(close) => (
        <DatePicker
          label={label}
          value={day}
          today={today}
          min={min}
          max={max}
          pick={(picked) => {
            close();
            set(picked === null ? null : dueDateFor(picked));
          }}
          done={close}
        />
      )}
    </Popover>
  );
};

/** PageSpace's fields for a task as one row of chips: status, dates, people, priority and its list. */
const fields = (task: Task, props: TaskDetailRenderProps): ReactNode => {
  const { list, actions, today } = props;
  const statuses = list.statuses.length === 0 ? defaultStatuses : list.statuses;
  const status: TaskStatus = statuses.find((entry) => entry.slug === task.status) ?? {
    id: task.status,
    slug: task.status,
    name: task.status,
    color: '',
    group: 'todo',
    position: 0,
    wipLimit: null,
  };
  const due = dueDay(task.dueDate);
  const start = dueDay(task.startDate);
  const priority = priorities.find((entry) => entry.value === task.priority);
  const priorityLabel = priority?.label ?? task.priority;
  const dueTone = dueToneOf(task.dueDate, today, isDone(list, task));
  if (!props.canEdit) {
    const agents = task.assignees.filter((entry) => entry.type === 'agent').map((entry) => entry.name);
    return (
      <div role="group" aria-label="Fields" className={taskFieldsClass}>
        <span className={taskStatusPillClass(status.group, false)}>
          {statusDot(status)}
          {status.name}
        </span>
        {dateField({ name: 'Due', value: task.dueDate, today, className: taskDueChipClass(dueTone, false) })}
        {dateField({ name: 'Start', value: task.startDate, today, className: taskChipReadOnlyClass })}
        <span className={taskChipReadOnlyClass}>
          {task.assignees.length === 0 ? (
            <span className={taskUnassignedClass}>Unassigned</span>
          ) : (
            <AvatarGroup names={task.assignees.map((entry) => entry.name)} agents={agents} label="Assigned to" />
          )}
        </span>
        <span className={taskChipReadOnlyClass}>
          {priorityGlyph(task.priority)}
          {priorityLabel}
        </span>
        <Link href={props.hrefFor(props.holder.pageId)} prefetch className={taskChipClass}>
          <Icon name="tasks" size={14} />
          {props.holder.title}
        </Link>
      </div>
    );
  }
  return (
    <div role="group" aria-label="Fields" className={taskFieldsClass}>
      <ChoiceMenu
        label="Status"
        value={task.status}
        options={statuses.map((entry) => ({ value: entry.slug, label: entry.name, leading: statusDot(entry) }))}
        choose={actions.setStatus}
        trigger={
          <button type="button" aria-label={`Status: ${status.name}`} className={taskStatusPillClass(status.group)}>
            {statusDot(status)}
            {status.name}
            <Icon name="chevronDown" size={12} />
          </button>
        }
      />
      <span className={taskFieldValueClass}>
        {dateField({
          name: 'Due',
          value: task.dueDate,
          today,
          min: start,
          className: taskDueChipClass(dueTone),
          set: actions.setDueDate,
        })}
        {due === '' || !props.dueSetByImago ? null : <span className={taskHintClass}>set by Imago</span>}
      </span>
      {dateField({ name: 'Start', value: task.startDate, today, max: due, className: taskChipClass, set: actions.setStartDate })}
      <AssigneePicker assigned={task.assignees} offered={offered(task, props.assignable)} toggle={actions.toggleAssignee} />
      <ChoiceMenu
        label="Priority"
        value={task.priority}
        options={priorities.map((entry) => ({ value: entry.value, label: entry.label, leading: priorityGlyph(entry.value) }))}
        choose={(value) => {
          if (isPriority(value)) actions.setPriority(value);
        }}
        trigger={
          <button type="button" aria-label={`Priority: ${priorityLabel}`} className={taskChipClass}>
            {priorityGlyph(task.priority)}
            {priorityLabel}
          </button>
        }
      />
      <Link href={props.hrefFor(props.holder.pageId)} prefetch className={taskChipClass}>
        <Icon name="tasks" size={14} />
        {props.holder.title}
      </Link>
    </div>
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
        toggleComplete: props.canEdit ? props.actions.toggleComplete : undefined,
        addTask: props.actions.addTask,
        editable: props.canEdit,
        taskHref: (entry) => props.hrefFor(entry.pageId),
        addLabel: 'Add subtask',
        addPlaceholder: 'Subtask title',
      })}
    </section>
  );
};

/**
 * A task opened as the object, every field edited where it sits: tick it,
 * rename it, set its status, priority, dates and people, describe it, delete it, and
 * work its subtasks. A refused edit says why under the title.
 */
export function renderTaskDetail(props: TaskDetailRenderProps): ReactNode {
  const task = props.path.at(-1);
  if (task === undefined) return null;
  const { list, notice, actions } = props;
  return (
    <>
      {strip(props)}
      <article className={taskDetailClass} aria-label={task.title}>
        {crumbs(props)}
        <div className={taskDetailTitleRowClass}>
          <Checkbox
            checked={isDone(list, task)}
            label={`Mark ${task.title} complete`}
            toggle={props.canEdit ? () => actions.toggleComplete(task.id) : undefined}
          />
          {titleInput(task, actions.rename, props.canEdit)}
        </div>
        {notice?.at === task.id ? (
          <p role="status" className={taskDetailNoticeClass}>
            {notice.message}
          </p>
        ) : null}
        {fields(task, props)}
        {props.automations}
        <section className={taskSectionClass}>
          <h3 className={taskSectionHeadingClass}>Description</h3>
          {props.description}
        </section>
        {subtasks(task, props)}
        {props.activity}
      </article>
    </>
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
