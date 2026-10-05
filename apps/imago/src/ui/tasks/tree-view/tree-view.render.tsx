import Link from 'next/link';
import type { ReactNode } from 'react';
import { Checkbox } from '../../components/checkbox/checkbox';
import { Icon } from '../../components/icon/icon';
import { InlineAdd } from '../../components/inline-add/inline-add';
import { ProgressMeter } from '../../components/progress-meter/progress-meter';
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

/** Why an edit was refused; `at` is the task (or list page) it was made on. */
export type TaskNotice = { readonly at: string; readonly message: string };

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

/**
 * One task and, while it is open, the level under it. `list` is the list
 * holding the task: its statuses decide whether the task is done.
 */
const row = (props: TreeViewRenderProps, list: TaskList, task: Task, level: number): ReactNode => {
  const below = task.subtasks;
  const branch = below !== null && below.tasks.length > 0;
  const open = branch && props.expandedIds.includes(task.id);
  const done = isDone(list, task);
  const { done: finished, total } = progress(task);
  return (
    <li key={task.id} data-task={task.id}>
      <div className={taskRowClass}>
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
        {total > 0 ? <ProgressMeter done={finished} total={total} /> : null}
      </div>
      {noticeAt(props, task.id)}
      {open ? (
        <ul className={taskChildrenClass} aria-label={task.title}>
          {below.tasks.map((child) => row(props, below, child, level + 1))}
          {canNestUnder(level) ? (
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
};

/**
 * The Tree view: the list as an indented outline. Every row has its
 * checkbox and, for a parent, a caret and the progress of its direct
 * subtasks; each open level ends in "Add subtask", the list in "Add task".
 * Nesting is a real `<ul>` per level; a refused edit's reason sits under
 * the row it was for.
 */
export function renderTreeView(props: TreeViewRenderProps): ReactNode {
  const { list, level = 0, addLabel = 'Add task', addPlaceholder = 'Task title' } = props;
  return (
    <ul className={taskLevelClass} aria-label={`${list.title} tasks`}>
      {list.tasks.map((task) => row(props, list, task, level + 1))}
      {level === 0 || canNestUnder(level) ? (
        <li>
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
