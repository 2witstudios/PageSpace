import Link from 'next/link';
import type { HTMLAttributes, ReactNode } from 'react';
import { AvatarGroup } from '../../components/avatar-group/avatar-group';
import { Checkbox } from '../../components/checkbox/checkbox';
import { Icon } from '../../components/icon/icon';
import { InlineAdd } from '../../components/inline-add/inline-add';
import { ProgressMeter } from '../../components/progress-meter/progress-meter';
import { dueDay } from '../task-detail/due-date';
import { dueLabel, dueToneOf, priorityFlag } from '../task-meta/task-meta';
import type { Task, TaskList } from '../task-model/task';
import {
  taskCaretClass,
  taskChildrenClass,
  taskLevelClass,
  taskNoticeClass,
  taskRowClass,
  taskSlotClass,
  taskTitleClass,
  taskToggleClass,
} from '../task-row/task-row-class';
import { canNestUnder, isDone, progress } from '../task-tree/task-tree';
import { treeDueClass, treeGripClass, treeMetaClass, treePriorityClass, treeRowShellClass } from './tree-view-class';

/** Why an edit was refused; `at` is the task (or list page) it was made on. */
export type TaskNotice = { readonly at: string; readonly message: string };

/** What a sortable row hands its render: where the drag library attaches, and the grip's props. */
export type RowDrag = {
  readonly ref: (element: HTMLElement | null) => void;
  readonly style: { readonly transform?: string; readonly transition?: string };
  readonly handle: HTMLAttributes<HTMLButtonElement>;
  readonly dragging: boolean;
};

/**
 * Wraps one level's rows so they can be reordered: `level` renders inside
 * it, and `row` gives each row its drag wiring. Supplied by TreeView; a tree
 * drawn without it (a board card's subtasks) does not reorder.
 */
export type TreeSorting = {
  readonly level: (list: TaskList, rows: ReactNode) => ReactNode;
  readonly row: (task: Task, render: (drag: RowDrag | null) => ReactNode) => ReactNode;
};

export type TreeViewRenderProps = {
  /** The open list, with every loaded level of subtasks. */
  readonly list: TaskList;
  readonly expandedIds: readonly string[];
  readonly notice: TaskNotice | null;
  /** Void action: shows or hides a task's subtasks. */
  readonly toggleExpanded: (taskId: string) => void;
  /** Void action: ticks a task, or unticks it. */
  readonly toggleComplete: (taskId: string) => void;
  /** Void action: adds a task to the list on `listPageId`; a refusal is shown at `at`. */
  readonly addTask: (listPageId: string, at: string, title: string) => void;
  /** Where a task's detail opens; without it, titles are plain text. */
  readonly taskHref?: (task: Task) => string;
  /** The level of the task whose subtasks `list` holds; 0 for a list of its own. */
  readonly level?: number;
  /** The list's own add control: "Add task" unless the list is a task's subtasks. */
  readonly addLabel?: string;
  readonly addPlaceholder?: string;
  /** False for a viewer who may only read: no add rows, no menus, no dragging. */
  readonly editable?: boolean;
  /** The viewer's own day, YYYY-MM-DD; without it rows show no due date. */
  readonly today?: string;
  /** A row's ⋯ menu, for a viewer who may edit. */
  readonly rowMenu?: (task: Task, list: TaskList) => ReactNode;
  readonly sorting?: TreeSorting;
};

const noticeAt = (props: TreeViewRenderProps, at: string): ReactNode =>
  props.notice?.at === at ? (
    <p role="status" className={taskNoticeClass}>
      {props.notice.message}
    </p>
  ) : null;

const lead = (props: TreeViewRenderProps, task: Task, branch: boolean, open: boolean): ReactNode =>
  branch ? (
    <button
      type="button"
      className={taskToggleClass}
      aria-expanded={open}
      aria-label={`Toggle ${task.title}`}
      onClick={() => props.toggleExpanded(task.id)}
    >
      <span className={taskCaretClass(open)} aria-hidden="true">
        <Icon name="chevronRight" size={12} />
      </span>
    </button>
  ) : (
    <span className={taskSlotClass} aria-hidden="true" />
  );

/** A row's facts after its title: progress, a flagged priority, its people and its due date. */
const meta = (props: TreeViewRenderProps, task: Task, done: boolean): ReactNode => {
  const { done: finished, total } = progress(task);
  const flag = priorityFlag(task);
  const tone = props.today === undefined ? null : dueToneOf(task.dueDate, props.today, done);
  const agents = task.assignees.filter((entry) => entry.type === 'agent').map((entry) => entry.name);
  return (
    <span className={treeMetaClass}>
      {total > 0 ? <ProgressMeter done={finished} total={total} /> : null}
      {flag === null ? null : (
        <span data-priority={flag.level} className={treePriorityClass(flag.level)} title={flag.label}>
          <Icon name="flag" size={12} />
          <span className="sr-only">{flag.label}</span>
        </span>
      )}
      {task.assignees.length === 0 ? null : (
        <AvatarGroup names={task.assignees.map((entry) => entry.name)} agents={agents} label="Assigned to" />
      )}
      {tone === null || props.today === undefined ? null : (
        <time dateTime={dueDay(task.dueDate)} data-tone={tone} className={treeDueClass(tone)}>
          {dueLabel(task.dueDate, props.today)}
        </time>
      )}
    </span>
  );
};

/**
 * One task and, while it is open, the level under it. `list` is the list
 * holding the task: its statuses decide whether the task is done.
 */
const row = (props: TreeViewRenderProps, list: TaskList, task: Task, level: number): ReactNode => {
  const below = task.subtasks;
  const branch = below !== null && below.tasks.length > 0;
  const open = branch && props.expandedIds.includes(task.id);
  const done = isDone(list, task);
  const editable = props.editable !== false;
  const draw = (drag: RowDrag | null): ReactNode => (
    <li
      key={task.id}
      ref={drag?.ref}
      style={drag?.style}
      data-task={task.id}
      data-dragging={drag?.dragging === true ? '' : undefined}
      className={treeRowShellClass}
    >
      <div className={taskRowClass}>
        {drag === null ? null : (
          <button type="button" className={treeGripClass} {...drag.handle} aria-label={`Drag ${task.title}`}>
            <Icon name="grip" size={12} />
          </button>
        )}
        {lead(props, task, branch, open)}
        <Checkbox checked={done} label={`Complete ${task.title}`} toggle={() => props.toggleComplete(task.id)} />
        {props.taskHref === undefined ? (
          <span className={taskTitleClass(done)} data-title="">
            {task.title}
          </span>
        ) : (
          <Link href={props.taskHref(task)} prefetch className={taskTitleClass(done)} data-title="">
            {task.title}
          </Link>
        )}
        {meta(props, task, done)}
        {editable && props.rowMenu !== undefined ? props.rowMenu(task, list) : null}
      </div>
      {noticeAt(props, task.id)}
      {open ? (
        <ul className={taskChildrenClass} aria-label={task.title}>
          {levelRows(props, below, level + 1)}
          {editable && canNestUnder(level) ? (
            <li>
              <InlineAdd
                label="Add subtask"
                placeholder="Subtask title"
                add={(title) => props.addTask(task.pageId, task.id, title)}
              />
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
  return props.sorting === undefined || !editable ? draw(null) : props.sorting.row(task, draw);
};

/** A level's rows, each `level` deep, inside the level's sorting context when there is one. */
const levelRows = (props: TreeViewRenderProps, list: TaskList, level: number): ReactNode => {
  const rows = list.tasks.map((task) => row(props, list, task, level));
  return props.sorting === undefined || props.editable === false ? rows : props.sorting.level(list, rows);
};

/**
 * The Tree view: the list as an indented outline. Every row has its
 * checkbox and, for a parent, a caret and the progress of its direct
 * subtasks, then its priority, people and due date; each open level ends in
 * "Add subtask", the list in "Add task". Nesting is a real `<ul>` per level;
 * a refused edit's reason sits under the row it was for.
 */
export function renderTreeView(props: TreeViewRenderProps): ReactNode {
  const { list, level = 0, addLabel = 'Add task', addPlaceholder = 'Task title' } = props;
  const editable = props.editable !== false;
  return (
    <ul className={taskLevelClass} aria-label={`${list.title} tasks`}>
      {levelRows(props, list, level + 1)}
      {editable && (level === 0 || canNestUnder(level)) ? (
        <li data-add-root={level === 0 ? '' : undefined}>
          <InlineAdd
            label={addLabel}
            placeholder={addPlaceholder}
            add={(title) => props.addTask(list.pageId, list.pageId, title)}
          />
          {noticeAt(props, list.pageId)}
        </li>
      ) : null}
    </ul>
  );
}
