import Link from 'next/link';
import type { CSSProperties, HTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import { renderAvatarGroup } from '../../components/avatar-group/avatar-group.render';
import { renderIcon } from '../../components/icon/icon.render';
import { InlineAdd } from '../../components/inline-add/inline-add';
import { renderProgressMeter } from '../../components/progress-meter/progress-meter.render';
import { renderSegmentedControl } from '../../components/segmented-control/segmented-control.render';
import { dueDay } from '../task-detail/due-date';
import { dueLabel, dueToneOf, isBlocked, priorityFlag } from '../task-meta/task-meta';
import type { Task, TaskStatus } from '../task-model/task';
import { taskCaretClass, taskNoticeClass, taskTitleClass, taskToggleClass } from '../task-row/task-row-class';
import { laneModes, wipTone, type DropPlace, type LaneMode } from './board';
import {
  boardAssigneesClass,
  boardBlockedClass,
  boardCardClass,
  boardCardMetaClass,
  boardCardRowClass,
  boardCardTitleClass,
  boardCardsClass,
  boardClass,
  boardColumnClass,
  boardColumnHeadClass,
  boardColumnTitleClass,
  boardColumnsClass,
  boardHeadCellClass,
  boardLaneClass,
  boardLaneHeadClass,
  boardLaneRowClass,
  boardLanesClass,
  boardRailHeadClass,
  boardCountClass,
  boardDotClass,
  boardDueClass,
  boardEmptyClass,
  boardHandleClass,
  boardHeadButtonClass,
  boardInsertClass,
  boardMenuClass,
  boardMenuDangerClass,
  boardMenuFieldClass,
  boardMenuItemClass,
  boardMenuNoteClass,
  boardMoveClass,
  boardMoveTriggerClass,
  boardPreviewClass,
  boardPriorityClass,
  boardRailButtonClass,
  boardRailClass,
  boardRailNameClass,
  boardRailTextClass,
  boardSubtasksClass,
  boardToolbarClass,
} from './board-view-class';

export type BoardRenderProps = {
  /** The board's accessible name. */
  readonly label: string;
  /** The columns, or with lanes the heads and the lanes' rows. */
  readonly body: ReactNode;
  /** The last move saved or refused, for screen readers. */
  readonly announcement: string;
  readonly lanes: LaneMode;
  /** Void action: splits the columns by another field, or by none. */
  readonly selectLanes: (mode: LaneMode) => void;
};

/**
 * The Board: the Lanes control, the columns under it, and a polite live
 * region that says where a moved task went, or why it could not go.
 */
export function renderBoard({ label, body, announcement, lanes, selectLanes }: BoardRenderProps): ReactNode {
  return (
    <div className={boardClass}>
      <div className={boardToolbarClass}>
        <span aria-hidden="true">Lanes</span>
        {renderSegmentedControl({ label: 'Lanes', segments: laneModes, value: lanes, select: selectLanes })}
      </div>
      <div role="group" aria-label={label} className={lanes === 'none' ? boardColumnsClass : boardLanesClass}>
        {body}
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

/** A lanes board's row of column heads, over every lane. */
export function renderLaneHeads(heads: ReactNode): ReactNode {
  return <div className={boardLaneRowClass}>{heads}</div>;
}

export type LaneRenderProps = {
  readonly label: string;
  readonly count: number;
  /** The lane's cells, one per column. */
  readonly cells: ReactNode;
};

/** One lane across the board: its name and count, then its row of cells. */
export function renderLane({ label, count, cells }: LaneRenderProps): ReactNode {
  return (
    <div role="group" aria-label={label} data-lane="" className={boardLaneClass}>
      <h3 className={boardLaneHeadClass}>
        {label}
        <span className={boardCountClass(null)}>{count}</span>
      </h3>
      <div className={boardLaneRowClass}>{cells}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Menus: a trigger, and a menu of buttons the arrows walk.

/** Arrows, Home and End move focus through the items, wrapping; Escape closes back to the trigger. */
const menuKeys = (triggerId: string, close: () => void) => (event: KeyboardEvent<HTMLElement>) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    document.getElementById(triggerId)?.focus();
    return;
  }
  // A field in the menu keeps its own arrows.
  if (event.target instanceof HTMLInputElement) return;
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

type MenuShell = {
  /** The element ids the trigger and menu are tied by. */
  readonly id: string;
  /** Marks the menu's root, so a press outside it can close it. */
  readonly menuKey: string;
  readonly triggerLabel: string;
  readonly triggerData: Readonly<Record<string, string>>;
  readonly triggerClass: string;
  readonly icon: ReactNode;
  readonly menuLabel: string;
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly items: ReactNode;
};

/** A menu button whose menu opens under it; Down opens it too, as a native menu button does. */
const menu = ({ id, menuKey, triggerLabel, triggerData, triggerClass, icon, menuLabel, open, setOpen, items }: MenuShell) => {
  const triggerId = `${id}-trigger`;
  return (
    <div className={boardMoveClass} data-menu-root={menuKey}>
      <button
        type="button"
        id={triggerId}
        {...triggerData}
        className={triggerClass}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={triggerLabel}
        title={triggerLabel}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        {icon}
      </button>
      {open ? (
        <div id={id} role="menu" aria-label={menuLabel} className={boardMenuClass} onKeyDown={menuKeys(triggerId, () => setOpen(false))}>
          {items}
        </div>
      ) : null}
    </div>
  );
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

/**
 * "Move to…": the keyboard's way across the board. A menu button whose menu
 * lists the other statuses; opening it focuses the first, the arrows walk
 * them, Enter chooses and Escape closes.
 */
export function renderMoveMenu({ title, taskId, targets, open, setOpen, choose }: MoveMenuRenderProps): ReactNode {
  return menu({
    id: `move-${taskId}`,
    menuKey: `move:${taskId}`,
    triggerLabel: `Move ${title} to…`,
    triggerData: { 'data-move': taskId },
    triggerClass: boardMoveTriggerClass,
    icon: renderIcon({ name: 'board', size: 14 }),
    menuLabel: `Move ${title} to`,
    open,
    setOpen,
    items: targets.map((status, index) => (
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
    )),
  });
}

export type CardMenuRenderProps = {
  readonly title: string;
  readonly taskId: string;
  /** Where the task opens; no Open item without it. */
  readonly href?: string;
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  /** Delete was chosen: the menu asks to be sure. */
  readonly confirming: boolean;
  readonly setConfirming: (confirming: boolean) => void;
  /** Void action: opens a field to add a subtask under the card. */
  readonly addSubtask: () => void;
  /** Void action: deletes the task. */
  readonly remove: () => void;
};

/**
 * A card's ⋯ menu: Open, Add subtask and Delete. Delete asks first, in the
 * menu itself, so the question is read where the focus already is.
 */
export function renderCardMenu(props: CardMenuRenderProps): ReactNode {
  const { title, taskId, href, open, setOpen, confirming, setConfirming, addSubtask, remove } = props;
  const items = confirming ? (
    <>
      <p className={boardMenuNoteClass}>{`Delete ${title}?`}</p>
      <button type="button" role="menuitem" autoFocus className={boardMenuDangerClass} onClick={remove}>
        Yes, delete
      </button>
      <button type="button" role="menuitem" className={boardMenuItemClass} onClick={() => setConfirming(false)}>
        No, keep it
      </button>
    </>
  ) : (
    <>
      {href === undefined ? null : (
        <Link href={href} role="menuitem" autoFocus className={boardMenuItemClass}>
          Open
        </Link>
      )}
      <button type="button" role="menuitem" autoFocus={href === undefined} className={boardMenuItemClass} onClick={addSubtask}>
        Add subtask
      </button>
      <button type="button" role="menuitem" className={boardMenuDangerClass} onClick={() => setConfirming(true)}>
        Delete…
      </button>
    </>
  );
  return menu({
    id: `card-${taskId}`,
    menuKey: `card:${taskId}`,
    triggerLabel: `More actions for ${title}`,
    triggerData: { 'data-card-menu': taskId },
    triggerClass: boardMoveTriggerClass,
    icon: renderIcon({ name: 'more', size: 14 }),
    menuLabel: `${title} actions`,
    open,
    setOpen,
    items,
  });
}

/** The WIP limit's editor in a column's menu. */
export type WipEditor = {
  readonly editing: boolean;
  readonly draft: string;
  /** Void action: swaps the item for the field, filled with the current limit. */
  readonly start: () => void;
  readonly type: (draft: string) => void;
  /** Void action: saves the draft; blank clears the limit. */
  readonly save: () => void;
};

export type ColumnMenuRenderProps = {
  readonly status: TaskStatus;
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  /** Null where the viewer may not set the list's limits. */
  readonly wip: WipEditor | null;
  /** Void action: folds the column to a rail. */
  readonly collapse: () => void;
};

/** A column's ⋯ menu: Set WIP limit… for an editor, and Collapse for everyone. */
export function renderColumnMenu({ status, open, setOpen, wip, collapse }: ColumnMenuRenderProps): ReactNode {
  const limitItem =
    wip === null ? null : wip.editing ? (
      <input
        // The field only exists because the viewer just asked for it.
        autoFocus
        type="number"
        min={1}
        max={999}
        inputMode="numeric"
        value={wip.draft}
        placeholder="No limit"
        aria-label={`WIP limit for ${status.name}`}
        className={boardMenuFieldClass}
        onChange={(event) => wip.type(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          wip.save();
        }}
      />
    ) : (
      <button type="button" role="menuitem" autoFocus className={boardMenuItemClass} onClick={wip.start}>
        Set WIP limit…
      </button>
    );
  return menu({
    id: `column-${status.slug}`,
    menuKey: `column:${status.slug}`,
    triggerLabel: `${status.name} column actions`,
    triggerData: { 'data-column-menu': status.slug },
    triggerClass: boardHeadButtonClass,
    icon: renderIcon({ name: 'more', size: 14 }),
    menuLabel: `${status.name} column`,
    open,
    setOpen,
    items: (
      <>
        {limitItem}
        <button type="button" role="menuitem" autoFocus={wip === null} className={boardMenuItemClass} onClick={collapse}>
          Collapse
        </button>
      </>
    ),
  });
}

// ---------------------------------------------------------------------------
// Columns.

/** How a column's header reads out: its name, how many cards it holds, and its limit. */
const headingLabel = (status: TaskStatus, count: number): string => {
  const cards = `${status.name}, ${count} ${count === 1 ? 'task' : 'tasks'}`;
  const tone = wipTone(count, status.wipLimit);
  if (tone === null) return cards;
  return `${cards}, limit ${status.wipLimit}${tone === 'over' ? ', over the limit' : ''}`;
};

/** The card count, or against a limit "count/limit", toned by how it stands. */
const countChip = (status: TaskStatus, count: number): ReactNode => {
  const tone = wipTone(count, status.wipLimit);
  return (
    <span data-count="" data-wip={tone ?? undefined} className={boardCountClass(tone)}>
      {tone === null ? count : `${count}/${status.wipLimit}`}
    </span>
  );
};

export type ColumnHeadRenderProps = {
  readonly status: TaskStatus;
  readonly count: number;
  /** Void action: opens the column's New card; null for a viewer who may only read. */
  readonly add: (() => void) | null;
  readonly menu: ColumnMenuRenderProps;
};

/** A column's head: its dot, name and count (or count against its limit), "+" and ⋯. */
export function renderColumnHead({ status, count, add, menu: columnMenu }: ColumnHeadRenderProps): ReactNode {
  return (
    <div data-column-head={status.slug} className={boardColumnHeadClass}>
      <h3 className={boardColumnTitleClass} aria-label={headingLabel(status, count)}>
        <span className={boardDotClass(status.group)} aria-hidden="true" />
        {status.name}
        {countChip(status, count)}
      </h3>
      {add === null ? null : (
        <button type="button" className={boardHeadButtonClass} aria-label={`New card in ${status.name}`} title="New card" onClick={add}>
          {renderIcon({ name: 'plus', size: 14 })}
        </button>
      )}
      {renderColumnMenu(columnMenu)}
    </div>
  );
}

/** Where a cell's New card adds: its id marks the control, so "+" can open it. */
export type NewCardRenderProps = {
  readonly cell: string;
  /** Void action: adds a card with this title to the cell. */
  readonly add: (title: string) => void;
};

export type BoardCellRenderProps = {
  readonly status: TaskStatus;
  /** The column's head; absent in a lanes board, whose heads have a row of their own. */
  readonly head?: ColumnHeadRenderProps;
  /** The cell's name: the status's, with the lane's after it in a lanes board. */
  readonly label: string;
  readonly count: number;
  /** A card is being dragged over this cell. */
  readonly target: boolean;
  /** Registers the cell as a place to drop cards. */
  readonly dropRef: (element: HTMLElement | null) => void;
  readonly cards: ReactNode;
  /** A card dragged in from elsewhere will land after the last one. */
  readonly insertAtEnd: boolean;
  /** Null for a viewer who may only read. */
  readonly newCard: NewCardRenderProps | null;
  /** Why the cell's last New card was refused. */
  readonly notice: string | null;
};

const insertLine = <div data-insert="" aria-hidden="true" className={boardInsertClass} />;

/**
 * One status's column (or a lane's cell of it): its head, its cards, then
 * New card. The count is the work in progress shown; a limit on it is
 * advisory and never stops a drop.
 */
export function renderBoardColumn({
  status,
  head,
  label,
  count,
  target,
  dropRef,
  cards,
  insertAtEnd,
  newCard,
  notice,
}: BoardCellRenderProps): ReactNode {
  return (
    <section ref={dropRef} data-column={status.slug} aria-label={label} className={boardColumnClass(target)}>
      {head === undefined ? null : renderColumnHead(head)}
      {count === 0 && !insertAtEnd ? <p className={boardEmptyClass}>No tasks</p> : null}
      <ul className={boardCardsClass} aria-label={`${label} tasks`}>
        {cards}
      </ul>
      {insertAtEnd ? insertLine : null}
      {newCard === null ? null : (
        <div data-new-card={newCard.cell}>
          <InlineAdd label="New card" placeholder="Card title" add={newCard.add} />
        </div>
      )}
      {notice === null ? null : (
        <p role="status" className={taskNoticeClass}>
          {notice}
        </p>
      )}
    </section>
  );
}

export type ColumnRailRenderProps = {
  readonly status: TaskStatus;
  readonly label: string;
  readonly count: number;
  readonly target: boolean;
  readonly dropRef: (element: HTMLElement | null) => void;
  /** Void action: opens the column back out. */
  readonly expand: () => void;
  /** Its name on end with the count; a lanes board's cells show only the count. */
  readonly named: boolean;
};

const railButton = ({ status, label, count, expand, named }: Omit<ColumnRailRenderProps, 'target' | 'dropRef'>) => (
  <button
    type="button"
    data-expand={status.slug}
    className={boardRailButtonClass}
    aria-expanded={false}
    aria-label={`Expand ${label}, ${count} ${count === 1 ? 'task' : 'tasks'}`}
    onClick={expand}
  >
    <span className={boardDotClass(status.group)} aria-hidden="true" />
    {countChip(status, count)}
    {named ? (
      <span className={boardRailNameClass} aria-hidden="true">
        <span className={boardRailTextClass}>{status.name}</span>
      </span>
    ) : null}
  </button>
);

/**
 * A column folded to a narrow rail: its count and, on end, its name; a
 * press opens it again. A card dropped on it still moves to its status.
 */
export function renderColumnRail(props: ColumnRailRenderProps): ReactNode {
  return (
    <section
      ref={props.dropRef}
      data-column={props.status.slug}
      data-collapsed=""
      aria-label={props.label}
      className={boardRailClass(props.target)}
    >
      {railButton(props)}
    </section>
  );
}

export type HeadCellRenderProps =
  | { readonly collapsed: false; readonly head: ColumnHeadRenderProps }
  | { readonly collapsed: true; readonly status: TaskStatus; readonly count: number; readonly expand: () => void };

/** A lanes board's head over one column: the column's head, or its rail's name on end. */
export function renderHeadCell(props: HeadCellRenderProps): ReactNode {
  return props.collapsed ? (
    <div key={props.status.slug} className={boardRailHeadClass}>
      {railButton({ status: props.status, label: props.status.name, count: props.count, expand: props.expand, named: true })}
    </div>
  ) : (
    <div key={props.head.status.slug} className={boardHeadCellClass}>
      {renderColumnHead(props.head)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards.

export type CardDrag = {
  /** Registers the card as the thing dragged and sorted. */
  readonly ref: (element: HTMLElement | null) => void;
  /** The drag library's attributes and listeners, spread on the handle. */
  readonly handle: HTMLAttributes<HTMLButtonElement>;
  readonly dragging: boolean;
  /** Where the sorted list has shifted the card to, while a drag is under way. */
  readonly style?: CSSProperties;
};

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
  /** Null for a viewer who may only read: no handle. */
  readonly drag: CardDrag | null;
  readonly move: MoveMenuRenderProps | null;
  readonly menu: CardMenuRenderProps | null;
  readonly subtasks: CardSubtasks | null;
  /** A card dragged in from another cell will land just before or after this one. */
  readonly insert: DropPlace | null;
  /** The field for a first subtask, opened from the card's menu. */
  readonly adding: ReactNode;
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
 * A task's card: a drag handle, its title, Move to… and ⋯; under them its
 * flags, subtask progress, due date and people. A card with subtasks opens
 * them in place. A refused move's reason sits under it.
 */
export function renderBoardCard({
  task,
  done,
  today,
  href,
  drag,
  move,
  menu: cardMenu,
  subtasks,
  insert,
  adding,
  notice,
}: BoardCardRenderProps): ReactNode {
  return (
    <li ref={drag?.ref} style={drag?.style} data-task={task.id}>
      {insert === 'before' ? insertLine : null}
      <article aria-label={task.title} className={boardCardClass({ dragging: drag?.dragging === true, done })}>
        <div className={boardCardRowClass}>
          {drag === null ? null : (
            <button type="button" data-drag={task.id} className={boardHandleClass} {...drag.handle} aria-label={`Drag ${task.title}`}>
              {renderIcon({ name: 'grip', size: 14 })}
            </button>
          )}
          {href === undefined ? (
            <span className={boardCardTitleClass(done)} data-title="">
              {task.title}
            </span>
          ) : (
            <Link href={href} prefetch className={boardCardTitleClass(done)} data-title="">
              {task.title}
            </Link>
          )}
          {subtasks === null ? null : caret(task.title, subtasks)}
          {move === null ? null : renderMoveMenu(move)}
          {cardMenu === null ? null : renderCardMenu(cardMenu)}
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
        {adding === null ? null : <div className={boardSubtasksClass}>{adding}</div>}
      </article>
      {insert === 'after' ? insertLine : null}
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
    <div className={boardPreviewClass} aria-hidden="true">
      <span className={taskTitleClass(false)}>{title}</span>
    </div>
  );
}
