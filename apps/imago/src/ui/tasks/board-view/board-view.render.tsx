import Link from 'next/link';
import type { HTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import { renderAvatarGroup } from '../../components/avatar-group/avatar-group.render';
import { renderIcon } from '../../components/icon/icon.render';
import { InlineAdd } from '../../components/inline-add/inline-add';
import { renderProgressMeter } from '../../components/progress-meter/progress-meter.render';
import { dueDay } from '../task-detail/due-date';
import { dueLabel, dueToneOf, isBlocked, priorityFlag } from '../task-meta/task-meta';
import type { Task, TaskStatus } from '../task-model/task';
import { taskCaretClass, taskNoticeClass, taskTitleClass, taskToggleClass } from '../task-row/task-row-class';
import {
  boardAssigneesClass,
  boardBlockedClass,
  boardCardClass,
  boardCardMetaClass,
  boardCardRowClass,
  boardCardsClass,
  boardClass,
  boardColumnClass,
  boardColumnHeadClass,
  boardCountClass,
  boardDotClass,
  boardDueClass,
  boardEmptyClass,
  boardHandleClass,
  boardMenuClass,
  boardMenuItemClass,
  boardMoveClass,
  boardMoveTriggerClass,
  boardPriorityClass,
  boardSubtasksClass,
} from './board-view-class';

export type BoardRenderProps = {
  /** The board's accessible name. */
  readonly label: string;
  readonly columns: ReactNode;
  /** The last move saved or refused, for screen readers. */
  readonly announcement: string;
};

/**
 * The Board: its columns side by side, and a polite live region that says
 * where a moved task went, or why it could not go.
 */
export function renderBoard({ label, columns, announcement }: BoardRenderProps): ReactNode {
  return (
    <>
      <div role="group" aria-label={label} className={boardClass}>
        {columns}
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </>
  );
}

export type BoardColumnRenderProps = {
  readonly status: TaskStatus;
  readonly count: number;
  /** A card is being dragged over this column. */
  readonly target: boolean;
  /** Registers the column as a place to drop cards. */
  readonly dropRef: (element: HTMLElement | null) => void;
  readonly cards: ReactNode;
  /** Void action: adds a card with this title to the column's status. */
  readonly newCard: (title: string) => void;
  /** Why the column's last New card was refused. */
  readonly notice: string | null;
};

/** How a column's header reads out: its name and how many cards it holds. */
const headingLabel = (status: TaskStatus, count: number): string =>
  `${status.name}, ${count} ${count === 1 ? 'task' : 'tasks'}`;

/**
 * One status's column: its dot, name and card count, its cards, then New
 * card. The count is the work in progress shown; PageSpace stores no limit
 * to hold it to.
 */
export function renderBoardColumn({
  status,
  count,
  target,
  dropRef,
  cards,
  newCard,
  notice,
}: BoardColumnRenderProps): ReactNode {
  return (
    <section ref={dropRef} data-column={status.slug} aria-label={status.name} className={boardColumnClass(target)}>
      <h3 className={boardColumnHeadClass} aria-label={headingLabel(status, count)}>
        <span className={boardDotClass(status.group)} aria-hidden="true" />
        {status.name}
        <span data-count="" className={boardCountClass}>
          {count}
        </span>
      </h3>
      {count === 0 ? <p className={boardEmptyClass}>No tasks</p> : null}
      <ul className={boardCardsClass} aria-label={`${status.name} tasks`}>
        {cards}
      </ul>
      <InlineAdd label="New card" placeholder="Card title" add={newCard} />
      {notice === null ? null : (
        <p role="status" className={taskNoticeClass}>
          {notice}
        </p>
      )}
    </section>
  );
}

export type CardDrag = {
  /** Registers the card as the thing dragged. */
  readonly ref: (element: HTMLElement | null) => void;
  /** The drag library's attributes and listeners, spread on the handle. */
  readonly handle: HTMLAttributes<HTMLButtonElement>;
  readonly dragging: boolean;
};

export type MoveMenuRenderProps = {
  readonly title: string;
  readonly taskId: string;
  /** Every status but the one the task is shown in. */
  readonly targets: readonly TaskStatus[];
  readonly open: boolean;
  /** Void action: opens or closes this task's menu. */
  readonly setOpen: (open: boolean) => void;
  /** Void action: moves the task to a status. */
  readonly choose: (status: TaskStatus) => void;
};

const menuId = (taskId: string) => `move-${taskId}`;

const triggerId = (taskId: string) => `move-${taskId}-trigger`;

/** Arrows, Home and End move focus through the items, wrapping; Escape closes back to the trigger. */
const menuKeys = (props: MoveMenuRenderProps) => (event: KeyboardEvent<HTMLElement>) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    props.setOpen(false);
    document.getElementById(triggerId(props.taskId))?.focus();
    return;
  }
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const at = items.findIndex((item) => item === document.activeElement);
  const next: Readonly<Record<string, number>> = {
    ArrowDown: (at + 1) % items.length,
    ArrowUp: (at - 1 + items.length) % items.length,
    Home: 0,
    End: items.length - 1,
  };
  const to = next[event.key];
  if (to === undefined) return;
  event.preventDefault();
  items[to]?.focus();
};

/**
 * "Move to…": the keyboard's way across the board. A menu button whose menu
 * lists the other statuses; opening it focuses the first, the arrows walk
 * them, Enter chooses and Escape closes.
 */
export function renderMoveMenu(props: MoveMenuRenderProps): ReactNode {
  const { title, taskId, targets, open, setOpen, choose } = props;
  return (
    <div className={boardMoveClass}>
      <button
        type="button"
        id={triggerId(taskId)}
        data-move={taskId}
        className={boardMoveTriggerClass}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId(taskId) : undefined}
        aria-label={`Move ${title} to…`}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        Move to…
      </button>
      {open ? (
        <div id={menuId(taskId)} role="menu" aria-label={`Move ${title} to`} className={boardMenuClass} onKeyDown={menuKeys(props)}>
          {targets.map((status, index) => (
            <button
              key={status.slug}
              type="button"
              role="menuitem"
              className={boardMenuItemClass}
              // The menu opens on purpose, so its first item takes focus as a native menu's does.
              autoFocus={index === 0}
              onClick={() => choose(status)}
            >
              <span className={boardDotClass(status.group)} aria-hidden="true" />
              {status.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A card's subtasks, for a task that has some loaded. */
export type CardSubtasks = {
  readonly open: boolean;
  /** Void action: shows or hides them. */
  readonly toggle: () => void;
  /** The subtasks as the Tree view's outline; drawn only while open. */
  readonly list: ReactNode;
};

export type BoardCardRenderProps = {
  readonly task: Task;
  /** Done by the status group of the list. */
  readonly done: boolean;
  /** The viewer's own day, YYYY-MM-DD, that due dates read against. */
  readonly today: string;
  /** Where the task's detail opens; the title is plain text without one. */
  readonly href?: string;
  readonly drag: CardDrag;
  readonly move: MoveMenuRenderProps;
  readonly subtasks: CardSubtasks | null;
  /** Why the card's last move was refused. */
  readonly notice: string | null;
};

/** Blocked and a raised or lowered priority: what needs attention before the date. */
const flags = (task: Task): ReactNode => {
  const priority = priorityFlag(task);
  return (
    <>
      {isBlocked(task) ? (
        <span data-blocked="" className={boardBlockedClass}>
          Blocked
        </span>
      ) : null}
      {priority === null ? null : (
        <span data-priority="" className={boardPriorityClass(priority.level)} title={priority.label}>
          {renderIcon({ name: 'flag', size: 12 })}
          <span className="sr-only">{priority.label}</span>
        </span>
      )}
    </>
  );
};

/** The due date by the viewer's own day, graded by how near it is. */
const due = (task: Task, today: string, done: boolean): ReactNode => {
  const tone = dueToneOf(task.dueDate, today, done);
  return tone === null ? null : (
    <time dateTime={dueDay(task.dueDate)} data-tone={tone} className={boardDueClass(tone)}>
      {dueLabel(task.dueDate, today)}
    </time>
  );
};

const caret = (title: string, subtasks: CardSubtasks): ReactNode => (
  <button
    type="button"
    className={taskToggleClass}
    aria-expanded={subtasks.open}
    aria-label={`Toggle ${title}`}
    onClick={subtasks.toggle}
  >
    <span className={taskCaretClass(subtasks.open)} aria-hidden="true">
      {renderIcon({ name: 'chevronRight', size: 12 })}
    </span>
  </button>
);

/**
 * A task's card: a drag handle, its title and Move to…; under them its
 * flags, subtask progress, due date and people. A card with subtasks opens
 * them in place. A refused move's reason sits under it.
 */
export function renderBoardCard({ task, done, today, href, drag, move, subtasks, notice }: BoardCardRenderProps): ReactNode {
  return (
    <li data-task={task.id}>
      <article ref={drag.ref} aria-label={task.title} className={boardCardClass(drag.dragging)}>
        <div className={boardCardRowClass}>
          <button type="button" data-drag={task.id} className={boardHandleClass} {...drag.handle} aria-label={`Drag ${task.title}`}>
            {renderIcon({ name: 'grip', size: 14 })}
          </button>
          {href === undefined ? (
            <span className={taskTitleClass(done)} data-title="">
              {task.title}
            </span>
          ) : (
            <Link href={href} prefetch className={taskTitleClass(done)} data-title="">
              {task.title}
            </Link>
          )}
          {subtasks === null ? null : caret(task.title, subtasks)}
          {renderMoveMenu(move)}
        </div>
        <div className={boardCardMetaClass}>
          {flags(task)}
          {task.subTaskCount > 0
            ? renderProgressMeter({ done: task.subTaskCompletedCount, total: task.subTaskCount })
            : null}
          {due(task, today, done)}
          <span className={boardAssigneesClass}>
            {renderAvatarGroup({
              names: task.assignees.map((entry) => entry.name),
              agents: task.assignees.filter((entry) => entry.type === 'agent').map((entry) => entry.name),
              label: 'Assigned to',
            })}
          </span>
        </div>
        {subtasks?.open === true ? <div className={boardSubtasksClass}>{subtasks.list}</div> : null}
      </article>
      {notice === null ? null : (
        <p role="status" className={taskNoticeClass}>
          {notice}
        </p>
      )}
    </li>
  );
}

/** The card under the pointer while it is dragged: its title alone. */
export function renderCardPreview(title: string): ReactNode {
  return (
    <div className={boardCardClass(false)} aria-hidden="true">
      <span className={taskTitleClass(false)}>{title}</span>
    </div>
  );
}
