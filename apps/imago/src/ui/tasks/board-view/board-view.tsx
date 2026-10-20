'use client';

// The Board bound to a list's writes. A card moves by drag (@dnd-kit, pointer
// or keyboard), within its column or across, or by its "Move to…" menu.
// A drop on a card lands next to it (useTaskList's moveTo saves the status,
// then the order); a drop on a column's open space lands at its end. In a
// lanes board the lane's field is saved first. Every write shows at once, is
// saved through the imago client and rolls back if the server refuses it.

import { useEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type Active,
  type Announcements,
  type ClientRect,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
  type Over,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  type SortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { InlineAdd } from '../../components/inline-add/inline-add';
import type { Task, TaskList, TaskStatus } from '../task-model/task';
import { isDoneStatus } from '../task-tree/task-tree';
import { browserStorage } from '../task-view/task-view';
import { renderTreeView, type TaskNotice } from '../tree-view/tree-view.render';
import type { ActionResult, TaskActions } from '../use-tasks/use-tasks';
import {
  boardColumns,
  boardLanes,
  boardRows,
  columnJump,
  dropPlace,
  moveAnnouncement,
  moveTargets,
  parseWipLimit,
  planDrop,
  readCollapsed,
  readLaneMode,
  toggledCollapsed,
  writeCollapsed,
  writeLaneMode,
  type BoardCell,
  type BoardColumn,
  type DropPlace,
  type DropPlan,
  type DropTarget,
  type LaneMode,
} from './board';
import {
  renderBoard,
  renderBoardCard,
  renderBoardColumn,
  renderCardPreview,
  renderColumnRail,
  renderHeadCell,
  renderLane,
  renderLaneHeads,
  type CardMenuRenderProps,
  type CardSubtasks,
  type ColumnHeadRenderProps,
  type MoveMenuRenderProps,
  type NewCardRenderProps,
} from './board-view.render';

export type BoardViewProps = {
  readonly list: TaskList;
  readonly actions: TaskActions;
  /** False for a viewer who may only read: no dragging, New card, writing menus or limits. */
  readonly editable: boolean;
  /**
   * False while the list shown is filtered: its order is not the list's, so
   * drops change status and lane but never the order.
   */
  readonly reorderable: boolean;
  /** The viewer's own day, YYYY-MM-DD, that due dates read against. */
  readonly today: string;
  /** Which tasks have their subtasks open, shared with the Tree view. */
  readonly expandedIds: readonly string[];
  /** Void action: shows or hides a task's subtasks. */
  readonly toggleExpanded: (taskId: string) => void;
  /** Where a card's task opens; titles are plain text without it. */
  readonly taskHref?: (task: Task) => string;
};

/** What the drag knows of each droppable: a cell of a lane, or a card in one. */
type DragData =
  | { readonly kind: 'cell'; readonly lane: string }
  | { readonly kind: 'card'; readonly lane: string; readonly cell: string };

const isDragData = (value: unknown): value is DragData =>
  typeof value === 'object' &&
  value !== null &&
  'kind' in value &&
  (value.kind === 'cell' || value.kind === 'card') &&
  'lane' in value &&
  typeof value.lane === 'string';

/**
 * Left and Right carry a held card a whole column, along its lane; Up and
 * Down walk it through the cards, as a sorted list does.
 */
const coordinateGetter: KeyboardCoordinateGetter = (event, args) => {
  if (event.code !== 'ArrowLeft' && event.code !== 'ArrowRight') return sortableKeyboardCoordinates(event, args);
  const { context } = args;
  const card = context.collisionRect;
  if (card === null) return undefined;
  const over = context.over;
  const overData: unknown = over?.data.current;
  const activeData: unknown = context.active?.data.current;
  const lane = isDragData(overData) ? overData.lane : isDragData(activeData) ? activeData.lane : null;
  const overCell =
    over === null || !isDragData(overData) ? null : overData.kind === 'cell' ? String(over.id) : overData.cell;
  const rects = [...context.droppableContainers.values()].flatMap((container) => {
    const data: unknown = container.data.current;
    const rect = context.droppableRects.get(container.id);
    if (!isDragData(data) || data.kind !== 'cell' || data.lane !== lane || rect === undefined) return [];
    return [{ id: String(container.id), left: rect.left, top: rect.top, width: rect.width, height: rect.height }];
  });
  const next = columnJump(event.code, rects, overCell, card);
  if (next !== undefined) event.preventDefault();
  return next;
};

const screenReaderInstructions = {
  draggable:
    'To pick up a task, press Space or Enter. Use the Up and Down arrow keys to move it among the cards, and Left and Right to carry it between columns. Press Space or Enter again to drop it, or Escape to cancel. Move to… does the same from a menu.',
};

type Lookup = {
  readonly title: (id: UniqueIdentifier) => string;
  readonly place: (id: UniqueIdentifier) => string;
};

/** The element under `root` whose data-<name> is `id`, matched without building a selector from it. */
const byData = (root: HTMLElement | null, name: string, id: string): HTMLElement | undefined =>
  [...(root?.querySelectorAll<HTMLElement>(`[data-${name}]`) ?? [])].find(
    (element) => element.getAttribute(`data-${name}`) === id,
  );

const announcements = ({ title, place }: Lookup): Announcements => ({
  onDragStart: ({ active }) => `Picked up ${title(active.id)}.`,
  onDragOver: ({ active, over }) =>
    over === null ? `${title(active.id)} is not over a column.` : `${title(active.id)} is over ${place(over.id)}.`,
  onDragEnd: ({ active, over }) =>
    over === null
      ? `${title(active.id)} was dropped where it was.`
      : `${title(active.id)} was dropped on ${place(over.id)}.`,
  onDragCancel: ({ active }) => `Moving ${title(active.id)} was cancelled.`,
});

/** A sorted list that shifts nothing: a filtered board never reorders. */
const unsorted: SortingStrategy = () => null;

const middle = (rect: ClientRect) => rect.top + rect.height / 2;

type CellProps = {
  readonly cell: BoardCell;
  readonly label: string;
  readonly head?: ColumnHeadRenderProps;
  readonly target: boolean;
  readonly insertAtEnd: boolean;
  readonly reorderable: boolean;
  readonly newCard: NewCardRenderProps | null;
  readonly notice: string | null;
  readonly children: ReactNode;
};

function Cell({ cell, label, head, target, insertAtEnd, reorderable, newCard, notice, children }: CellProps) {
  const data: DragData = { kind: 'cell', lane: cell.lane.key };
  const { setNodeRef } = useDroppable({ id: cell.id, data });
  return renderBoardColumn({
    status: cell.status,
    head,
    label,
    count: cell.tasks.length,
    target,
    dropRef: setNodeRef,
    insertAtEnd,
    newCard,
    notice,
    cards: (
      <SortableContext
        id={cell.id}
        items={cell.tasks.map((task) => task.id)}
        strategy={reorderable ? verticalListSortingStrategy : unsorted}
      >
        {children}
      </SortableContext>
    ),
  });
}

type RailProps = {
  readonly cell: BoardCell;
  readonly label: string;
  readonly count: number;
  readonly target: boolean;
  readonly named: boolean;
  readonly expand: () => void;
};

function Rail({ cell, label, count, target, named, expand }: RailProps) {
  const data: DragData = { kind: 'cell', lane: cell.lane.key };
  const { setNodeRef } = useDroppable({ id: cell.id, data });
  return renderColumnRail({ status: cell.status, label, count, target, dropRef: setNodeRef, expand, named });
}

type CardProps = {
  readonly task: Task;
  readonly cell: BoardCell;
  readonly editable: boolean;
  readonly done: boolean;
  readonly today: string;
  readonly href: string | undefined;
  readonly move: MoveMenuRenderProps | null;
  readonly menu: CardMenuRenderProps | null;
  readonly subtasks: CardSubtasks | null;
  readonly insert: DropPlace | null;
  readonly adding: ReactNode;
  readonly notice: string | null;
};

function Card({ task, cell, editable, ...card }: CardProps) {
  const data: DragData = { kind: 'card', lane: cell.lane.key, cell: cell.id };
  const { setNodeRef, attributes, listeners, isDragging, transform, transition } = useSortable({
    id: task.id,
    data,
    disabled: !editable,
  });
  return renderBoardCard({
    ...card,
    task,
    drag: editable
      ? {
          ref: setNodeRef,
          handle: { ...attributes, ...listeners },
          dragging: isDragging,
          style: { transform: CSS.Translate.toString(transform), transition },
        }
      : null,
  });
}

/** Where a refusal is shown: under a card, in a cell (New card) or in a column (its limit). */
const cellNotice = (id: string) => `cell:${id}`;
const columnNotice = (slug: string) => `column:${slug}`;

/** Where the pointer or keyboard holds a card: the cell, and how it would land there. */
type Hover = { readonly cell: BoardCell; readonly target: DropTarget };

type Prefs = { readonly pageId: string; readonly lanes: LaneMode; readonly collapsed: readonly string[] };

const loadPrefs = (pageId: string): Prefs => ({
  pageId,
  lanes: readLaneMode(browserStorage(), pageId),
  collapsed: readCollapsed(browserStorage(), pageId),
});

/**
 * The Board: a column per status of the list, optionally split into lanes,
 * holding its top-level tasks, each column ending in New card. Which menu is
 * open, which card is in flight and where, the last refusal and the last
 * announcement are its own state; lanes and folded columns are the viewer's,
 * kept in this browser; the tasks are useTaskList's, and which cards are
 * open is the Tree's.
 */
export function BoardView({
  list,
  actions,
  editable,
  reorderable,
  today,
  expandedIds,
  toggleExpanded,
  taskHref,
}: BoardViewProps) {
  const columns = useMemo(() => boardColumns(list), [list]);
  const [stored, setPrefs] = useState<Prefs>(() => loadPrefs(list.pageId));
  // Another list opened in place: its own choices, read once.
  const prefs = stored.pageId === list.pageId ? stored : loadPrefs(list.pageId);
  if (prefs !== stored) setPrefs(prefs);
  const { lanes: mode, collapsed } = prefs;
  const rows = useMemo(() => boardRows(columns, boardLanes(list, mode), mode), [columns, list, mode]);

  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [wip, setWip] = useState<{ readonly slug: string; readonly draft: string } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [notice, setNotice] = useState<TaskNotice | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [refocus, setRefocus] = useState<{ readonly id: string; readonly on: 'move' | 'drag' } | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [openAdd, setOpenAdd] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const sensors = useSensors(
    // A click on the handle stays a click; a drag starts once the pointer travels.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter }),
  );

  const tasks = useMemo(() => new Map(columns.flatMap((column) => column.tasks.map((task) => [task.id, task]))), [columns]);
  const cells = useMemo(() => new Map(rows.flatMap((row) => row.cells.map((cell) => [cell.id, cell]))), [rows]);
  const cellOfTask = useMemo(
    () => new Map(rows.flatMap((row) => row.cells.flatMap((cell) => cell.tasks.map((task) => [task.id, cell])))),
    [rows],
  );
  const cellLabel = (cell: BoardCell) => (mode === 'none' ? cell.status.name : `${cell.status.name}, ${cell.lane.label}`);
  const lookup: Lookup = {
    title: (id) => tasks.get(String(id))?.title ?? 'The task',
    place: (id) => {
      const cell = cells.get(String(id)) ?? cellOfTask.get(String(id));
      return cell === undefined ? 'a column' : cellLabel(cell);
    },
  };

  // A card under the pointer wins over the cell it sits in; the keyboard,
  // which has no pointer, goes by overlap.
  const collisionDetection: CollisionDetection = (args) => {
    const within = pointerWithin(args);
    if (within.length === 0) return rectIntersection(args);
    const card = within.find((collision) => tasks.has(String(collision.id)));
    return card === undefined ? within.slice(0, 1) : [card];
  };

  const hoverOf = (active: Active, over: Over | null): Hover | null => {
    if (over === null) return null;
    const overId = String(over.id);
    const cardCell = cellOfTask.get(overId);
    if (cardCell !== undefined) {
      const held = active.rect.current.translated;
      const below = held !== null && middle(held) > middle(over.rect);
      return {
        cell: cardCell,
        target: { kind: 'card', overId, place: dropPlace(cardCell, String(active.id), overId, below) },
      };
    }
    const cell = cells.get(overId);
    return cell === undefined ? null : { cell, target: { kind: 'cell' } };
  };

  // A moved card is drawn anew in its new column, so focus would fall to the
  // page: put it back on the control the move was made from.
  useEffect(() => {
    if (refocus === null) return;
    const focused = document.activeElement;
    if (focused !== null && focused !== document.body && root.current?.contains(focused)) return;
    byData(root.current, refocus.on, refocus.id)?.focus();
  });

  // A press outside the open menu closes it, as a native menu would.
  useEffect(() => {
    if (menuFor === null) return;
    const onPointerDown = (event: PointerEvent) => {
      const open = byData(root.current, 'menu-root', menuFor);
      if (!(event.target instanceof Node) || !open?.contains(event.target)) setMenuFor(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuFor]);

  // An add asked for from a card's menu or a column's "+": open its field
  // once it is drawn. The field focuses itself as it opens.
  useEffect(() => {
    if (openAdd === null) return;
    const [kind, id] = openAdd.split('|') as [string, string];
    const scope = kind === 'cell' ? byData(root.current, 'new-card', id) : byData(root.current, 'task', id)?.querySelector('article');
    if (scope === undefined || scope === null) return;
    const field = scope.querySelector<HTMLInputElement>('input');
    const rest = [...scope.querySelectorAll<HTMLButtonElement>('button:not([role="menuitem"])')]
      .filter((button) => button.textContent === (kind === 'cell' ? 'New card' : 'Add subtask'))
      .at(-1);
    setOpenAdd(null);
    if (field !== null) field.focus();
    else rest?.click();
  }, [openAdd]);

  const openMenu = (key: string | null) => {
    setMenuFor(key);
    setConfirming(false);
    setWip(null);
  };

  const savePrefs = (next: Prefs) => {
    setPrefs(next);
    writeLaneMode(browserStorage(), next.pageId, next.lanes);
    writeCollapsed(browserStorage(), next.pageId, next.collapsed);
  };
  const toggleCollapsed = (slug: string) => {
    openMenu(null);
    savePrefs({ ...prefs, collapsed: toggledCollapsed(collapsed, slug) });
  };

  const report = (at: string) => (result: ActionResult) =>
    setNotice(result.ok ? null : { at, message: result.refusal });

  const announce = (task: Task, status: TaskStatus, from: 'move' | 'drag', write: () => Promise<ActionResult>) => {
    setRefocus({ id: task.id, on: from });
    void write().then((result) => {
      setNotice(result.ok ? null : { at: task.id, message: result.refusal });
      setAnnouncement(moveAnnouncement(task.title, status.name, result));
      setRefocus(null);
    });
  };

  /** A drop's writes in order: the lane's field, then status and place; a refusal stops the rest. */
  const applyDrop = async (task: Task, plan: DropPlan): Promise<ActionResult> => {
    const change = plan.change;
    if (change !== null) {
      const changed =
        change.field === 'priority'
          ? await actions.update(task.id, { priority: change.priority })
          : await actions.setAssignees(task.id, change.assignees);
      if (!changed.ok) return changed;
    }
    if (plan.index !== null) return actions.moveTo(task.id, plan.status.slug, plan.index);
    if (plan.statusChanged) return actions.setStatus(task.id, plan.status.slug);
    return { ok: true };
  };

  const moveMenuOf = (task: Task): MoveMenuRenderProps => ({
    title: task.title,
    taskId: task.id,
    targets: moveTargets(columns, task.id),
    open: menuFor === `move:${task.id}`,
    setOpen: (open) => openMenu(open ? `move:${task.id}` : null),
    choose: (status) => {
      openMenu(null);
      announce(task, status, 'move', () => actions.setStatus(task.id, status.slug));
    },
  });

  const cardMenuOf = (task: Task): CardMenuRenderProps => ({
    title: task.title,
    taskId: task.id,
    href: taskHref?.(task),
    open: menuFor === `card:${task.id}`,
    setOpen: (open) => openMenu(open ? `card:${task.id}` : null),
    confirming,
    setConfirming,
    addSubtask: () => {
      openMenu(null);
      const loaded = task.subtasks !== null && task.subtasks.tasks.length > 0;
      if (loaded && !expandedIds.includes(task.id)) toggleExpanded(task.id);
      if (!loaded) setAddingTo(task.id);
      setOpenAdd(`task|${task.id}`);
    },
    remove: () => {
      openMenu(null);
      void actions.remove(task.id).then((result) => {
        setNotice(result.ok ? null : { at: task.id, message: result.refusal });
        setAnnouncement(result.ok ? `Deleted ${task.title}.` : `Could not delete ${task.title}: ${result.refusal}`);
      });
    },
  });

  /** A card's subtasks as the Tree's outline, a level down: tick, open and add them in place. */
  const subtasksOf = (task: Task): CardSubtasks | null => {
    const below = task.subtasks;
    if (below === null || below.tasks.length === 0) return null;
    return {
      open: expandedIds.includes(task.id),
      toggle: () => toggleExpanded(task.id),
      list: renderTreeView({
        list: below,
        level: 1,
        expandedIds,
        notice,
        toggleExpanded,
        toggleComplete: (taskId) => {
          void actions.toggleComplete(taskId).then(report(taskId));
        },
        addTask: (listPageId, at, title) => {
          void actions.create(listPageId, { title }).then(report(at));
        },
        taskHref,
        addLabel: 'Add subtask',
        addPlaceholder: 'Subtask title',
        editable,
      }),
    };
  };

  /** The field for a card's first subtask; it goes once focus leaves it. */
  const firstSubtask = (task: Task): ReactNode => (
    <div
      onBlur={(event: FocusEvent<HTMLDivElement>) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setAddingTo(null);
      }}
    >
      <InlineAdd
        label="Add subtask"
        placeholder="Subtask title"
        add={(title) => {
          if (!expandedIds.includes(task.id)) toggleExpanded(task.id);
          void actions.create(task.pageId, { title }).then(report(task.id));
          // The card now has subtasks: carry on in their own Add subtask.
          setAddingTo(null);
          setOpenAdd(`task|${task.id}`);
        }}
      />
    </div>
  );

  /** A New card goes to the end of the list in its cell's status, and lane. */
  const newCard = (cell: BoardCell): NewCardRenderProps | null => {
    if (!editable) return null;
    const change = cell.lane.change;
    const lane =
      change === null ? {} : change.field === 'priority' ? { priority: change.priority } : { assignees: change.assignees };
    return {
      cell: cell.id,
      add: (title) => {
        void actions.create(list.pageId, { title, status: cell.status.slug, ...lane }).then(report(cellNotice(cell.id)));
      },
    };
  };

  const headOf = (column: BoardColumn, first: BoardCell | undefined): ColumnHeadRenderProps => {
    const { status } = column;
    const key = `column:${status.slug}`;
    return {
      status,
      count: column.tasks.length,
      add: editable && first !== undefined ? () => setOpenAdd(`cell|${first.id}`) : null,
      menu: {
        status,
        open: menuFor === key,
        setOpen: (open) => openMenu(open ? key : null),
        collapse: () => toggleCollapsed(status.slug),
        // Fallback statuses are not the list's own: there is no row to hold a limit.
        wip:
          editable && list.statuses.length > 0
            ? {
                editing: wip?.slug === status.slug,
                draft: wip?.slug === status.slug ? wip.draft : '',
                start: () => setWip({ slug: status.slug, draft: status.wipLimit === null ? '' : String(status.wipLimit) }),
                type: (draft) => setWip({ slug: status.slug, draft }),
                save: () => {
                  const limit = parseWipLimit(wip?.draft ?? '');
                  openMenu(null);
                  void actions.setWipLimit(status.slug, limit).then((result) => {
                    report(columnNotice(status.slug))(result);
                    if (!result.ok) setAnnouncement(`Could not set the limit on ${status.name}: ${result.refusal}`);
                  });
                },
              }
            : null,
      },
    };
  };

  const active = activeId === null ? undefined : tasks.get(activeId);
  const activeCell = activeId === null ? undefined : cellOfTask.get(activeId);
  /** Only a card from another cell needs a line: within its own, the sorted cards make room. */
  const landing = hover !== null && reorderable && activeCell?.id !== hover.cell.id ? hover : null;

  const noticeFor = (cell: BoardCell, firstInColumn: boolean): string | null => {
    if (notice?.at === cellNotice(cell.id)) return notice.message;
    if (firstInColumn && notice?.at === columnNotice(cell.status.slug)) return notice.message;
    return null;
  };

  const cellOf = (cell: BoardCell, firstInColumn: boolean, column: BoardColumn): ReactNode => {
    const target = activeId !== null && hover?.cell.id === cell.id;
    if (collapsed.includes(cell.status.slug)) {
      return (
        <Rail
          key={cell.id}
          cell={cell}
          label={cellLabel(cell)}
          count={mode === 'none' ? column.tasks.length : cell.tasks.length}
          target={target}
          named={mode === 'none'}
          expand={() => toggleCollapsed(cell.status.slug)}
        />
      );
    }
    const at = landing?.cell.id === cell.id ? landing.target : null;
    return (
      <Cell
        key={cell.id}
        cell={cell}
        label={cellLabel(cell)}
        head={mode === 'none' ? headOf(column, cell) : undefined}
        target={target}
        insertAtEnd={at?.kind === 'cell'}
        reorderable={reorderable}
        newCard={newCard(cell)}
        notice={noticeFor(cell, firstInColumn)}
      >
        {cell.tasks.map((task) => (
          <Card
            key={task.id}
            task={task}
            cell={cell}
            editable={editable}
            done={isDoneStatus(list.statuses, cell.status.slug)}
            today={today}
            href={taskHref?.(task)}
            move={editable ? moveMenuOf(task) : null}
            menu={editable ? cardMenuOf(task) : null}
            subtasks={subtasksOf(task)}
            insert={at?.kind === 'card' && at.overId === task.id ? at.place : null}
            adding={addingTo === task.id && subtasksOf(task) === null ? firstSubtask(task) : null}
            notice={notice?.at === task.id ? notice.message : null}
          />
        ))}
      </Cell>
    );
  };

  const body =
    mode === 'none' ? (
      (rows[0]?.cells ?? []).map((cell, index) => cellOf(cell, true, columns[index] as BoardColumn))
    ) : (
      <>
        {renderLaneHeads(
          columns.map((column) =>
            collapsed.includes(column.status.slug)
              ? renderHeadCell({
                  collapsed: true,
                  status: column.status,
                  count: column.tasks.length,
                  expand: () => toggleCollapsed(column.status.slug),
                })
              : renderHeadCell({ collapsed: false, head: headOf(column, rows[0]?.cells.find((cell) => cell.status.slug === column.status.slug)) }),
          ),
        )}
        {rows.map((row, lane) => (
          <div key={row.lane.key} className="contents">
            {renderLane({
              label: row.lane.label,
              count: row.cells.reduce((sum, cell) => sum + cell.tasks.length, 0),
              cells: row.cells.map((cell, index) => cellOf(cell, lane === 0, columns[index] as BoardColumn)),
            })}
          </div>
        ))}
      </>
    );

  const endDrag = () => {
    setActiveId(null);
    setHover(null);
  };

  return (
    <div ref={root} className="contents">
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        accessibility={{ announcements: announcements(lookup), screenReaderInstructions }}
        onDragStart={({ active: dragged }) => {
          openMenu(null);
          setActiveId(String(dragged.id));
        }}
        onDragOver={({ active: dragged, over }) => setHover(hoverOf(dragged, over))}
        onDragMove={({ active: dragged, over }) => {
          const next = hoverOf(dragged, over);
          // Only a change of side is news; the rest of a move redraws nothing.
          const same =
            next?.cell.id === hover?.cell.id &&
            next?.target.kind === hover?.target.kind &&
            (next?.target.kind !== 'card' || hover?.target.kind !== 'card' || (next.target.overId === hover.target.overId && next.target.place === hover.target.place));
          if (!same) setHover(next);
        }}
        onDragCancel={endDrag}
        onDragEnd={({ active: dragged, over }) => {
          endDrag();
          const id = String(dragged.id);
          const task = tasks.get(id);
          const at = hoverOf(dragged, over);
          if (task === undefined || at === null) return;
          const plan = planDrop(list, columns, id, at.cell, at.target, mode, reorderable);
          if (plan !== null) announce(task, plan.status, 'drag', () => applyDrop(task, plan));
        }}
      >
        {renderBoard({
          label: `${list.title} board`,
          announcement,
          lanes: mode,
          selectLanes: (lanes) => savePrefs({ ...prefs, lanes }),
          body,
        })}
        <DragOverlay dropAnimation={null}>{active === undefined ? null : renderCardPreview(active.title)}</DragOverlay>
      </DndContext>
    </div>
  );
}
