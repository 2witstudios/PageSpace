'use client';

// The Board bound to a list's writes. A card moves by drag (@dnd-kit/core,
// pointer or keyboard) or by its "Move to…" menu; either way the move is
// useTaskList's setStatus, so it shows at once, is saved through the imago
// client and rolls back if the server refuses it.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import type { Task, TaskList, TaskStatus } from '../task-model/task';
import { isDoneStatus } from '../task-tree/task-tree';
import { renderTreeView, type TaskNotice } from '../tree-view/tree-view.render';
import type { ActionResult, TaskActions } from '../use-tasks/use-tasks';
import { boardColumns, columnJump, dropStatus, moveAnnouncement, moveTargets, type BoardColumn } from './board';
import {
  renderBoard,
  renderBoardCard,
  renderBoardColumn,
  renderCardPreview,
  type CardSubtasks,
  type MoveMenuRenderProps,
} from './board-view.render';

export type BoardViewProps = {
  readonly list: TaskList;
  readonly actions: TaskActions;
  /** The viewer's own day, YYYY-MM-DD, that due dates read against. */
  readonly today: string;
  /** Which tasks have their subtasks open, shared with the Tree view. */
  readonly expandedIds: readonly string[];
  /** Void action: shows or hides a task's subtasks. */
  readonly toggleExpanded: (taskId: string) => void;
  /** Where a card's task opens; titles are plain text without it. */
  readonly taskHref?: (task: Task) => string;
};

/** Left and Right carry a held card a whole column; Up and Down do nothing. */
const coordinateGetter: KeyboardCoordinateGetter = (event, { context }) => {
  const card = context.collisionRect;
  if (card === null) return undefined;
  const rects = [...context.droppableRects.entries()].map(([id, rect]) => ({
    id: String(id),
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  }));
  const next = columnJump(event.code, rects, context.over === null ? null : String(context.over.id), card);
  if (next !== undefined) event.preventDefault();
  return next;
};

const screenReaderInstructions = {
  draggable:
    'To pick up a task, press Space or Enter. Use the Left and Right arrow keys to carry it between columns. Press Space or Enter again to drop it, or Escape to cancel. Move to… does the same from a menu.',
};

type Lookup = {
  readonly title: (id: UniqueIdentifier) => string;
  readonly statusName: (id: UniqueIdentifier) => string;
};

/** The element under `root` whose data-<name> is `id`, matched without building a selector from it. */
const byData = (root: HTMLElement | null, name: string, id: string): HTMLElement | undefined =>
  [...(root?.querySelectorAll<HTMLElement>(`[data-${name}]`) ?? [])].find(
    (element) => element.getAttribute(`data-${name}`) === id,
  );

const announcements = ({ title, statusName }: Lookup): Announcements => ({
  onDragStart: ({ active }) => `Picked up ${title(active.id)}.`,
  onDragOver: ({ active, over }) =>
    over === null
      ? `${title(active.id)} is not over a column.`
      : `${title(active.id)} is over ${statusName(over.id)}.`,
  onDragEnd: ({ active, over }) =>
    over === null
      ? `${title(active.id)} was dropped where it was.`
      : `${title(active.id)} was dropped on ${statusName(over.id)}.`,
  onDragCancel: ({ active }) => `Moving ${title(active.id)} was cancelled.`,
});

type ColumnProps = {
  readonly column: BoardColumn;
  readonly target: boolean;
  readonly newCard: (title: string) => void;
  readonly notice: string | null;
  readonly children: ReactNode;
};

function Column({ column, target, newCard, notice, children }: ColumnProps) {
  const { setNodeRef } = useDroppable({ id: column.status.slug });
  return renderBoardColumn({
    status: column.status,
    count: column.tasks.length,
    target,
    dropRef: setNodeRef,
    cards: children,
    newCard,
    notice,
  });
}

type CardProps = {
  readonly task: Task;
  readonly done: boolean;
  readonly today: string;
  readonly href: string | undefined;
  readonly move: MoveMenuRenderProps;
  readonly subtasks: CardSubtasks | null;
  readonly notice: string | null;
};

function Card({ task, done, today, href, move, subtasks, notice }: CardProps) {
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({ id: task.id });
  return renderBoardCard({
    task,
    done,
    today,
    href,
    drag: { ref: setNodeRef, handle: { ...attributes, ...listeners }, dragging: isDragging },
    move,
    subtasks,
    notice,
  });
}

/** Where a column's New card refusal is shown: apart from any task's. */
const columnNotice = (slug: string) => `column:${slug}`;

/**
 * The Board: a column per status of the list, holding its top-level tasks,
 * each column ending in New card. Which card's menu is open, which card is
 * in flight, the last refusal and the last announcement are its own state;
 * the tasks are useTaskList's, and which cards are open is the Tree's.
 */
export function BoardView({ list, actions, today, expandedIds, toggleExpanded, taskHref }: BoardViewProps) {
  const columns = useMemo(() => boardColumns(list), [list]);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [notice, setNotice] = useState<TaskNotice | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [refocus, setRefocus] = useState<{ readonly id: string; readonly on: 'move' | 'drag' } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const sensors = useSensors(
    // A click on the handle stays a click; a drag starts once the pointer travels.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter }),
  );

  const tasks = useMemo(() => new Map(columns.flatMap((column) => column.tasks.map((task) => [task.id, task]))), [columns]);
  const statuses = useMemo(() => new Map(columns.map((column) => [column.status.slug, column.status])), [columns]);
  const lookup: Lookup = {
    title: (id) => tasks.get(String(id))?.title ?? 'The task',
    statusName: (id) => statuses.get(String(id))?.name ?? 'a column',
  };

  // A moved card is drawn anew in its new column, so focus would fall to the
  // page: put it back on the control the move was made from.
  useEffect(() => {
    if (refocus === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && root.current?.contains(active)) return;
    byData(root.current, refocus.on, refocus.id)?.focus();
  });

  // A press outside the open menu closes it, as a native menu would.
  useEffect(() => {
    if (menuFor === null) return;
    const onPointerDown = (event: PointerEvent) => {
      const menu = byData(root.current, 'move', menuFor)?.parentElement;
      if (!(event.target instanceof Node) || !menu?.contains(event.target)) setMenuFor(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuFor]);

  const move = (task: Task, status: TaskStatus, from: 'move' | 'drag') => {
    setRefocus({ id: task.id, on: from });
    void actions.setStatus(task.id, status.slug).then((result) => {
      setNotice(result.ok ? null : { at: task.id, message: result.refusal });
      setAnnouncement(moveAnnouncement(task.title, status.name, result));
      setRefocus(null);
    });
  };

  const menuOf = (task: Task): MoveMenuRenderProps => ({
    title: task.title,
    taskId: task.id,
    targets: moveTargets(columns, task.id),
    open: menuFor === task.id,
    setOpen: (open) => setMenuFor(open ? task.id : null),
    choose: (status) => {
      setMenuFor(null);
      move(task, status, 'move');
    },
  });

  const report = (at: string) => (result: ActionResult) =>
    setNotice(result.ok ? null : { at, message: result.refusal });

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
      }),
    };
  };

  /** A New card goes to the end of the list in its column's status. */
  const newCard = (status: TaskStatus) => (title: string) => {
    void actions.create(list.pageId, { title, status: status.slug }).then(report(columnNotice(status.slug)));
  };

  const active = activeId === null ? undefined : tasks.get(activeId);

  return (
    <div ref={root} className="contents">
      <DndContext
        sensors={sensors}
        collisionDetection={rectIntersection}
        accessibility={{ announcements: announcements(lookup), screenReaderInstructions }}
        onDragStart={({ active: dragged }) => {
          setMenuFor(null);
          setActiveId(String(dragged.id));
        }}
        onDragOver={({ over }) => setOverId(over === null ? null : String(over.id))}
        onDragCancel={() => {
          setActiveId(null);
          setOverId(null);
        }}
        onDragEnd={({ active: dragged, over }) => {
          setActiveId(null);
          setOverId(null);
          const id = String(dragged.id);
          const slug = dropStatus(columns, id, over === null ? null : String(over.id));
          const task = tasks.get(id);
          const status = slug === null ? undefined : statuses.get(slug);
          if (task !== undefined && status !== undefined) move(task, status, 'drag');
        }}
      >
        {renderBoard({
          label: `${list.title} board`,
          announcement,
          columns: columns.map((column) => (
            <Column
              key={column.status.slug}
              column={column}
              target={activeId !== null && overId === column.status.slug}
              newCard={newCard(column.status)}
              notice={notice?.at === columnNotice(column.status.slug) ? notice.message : null}
            >
              {column.tasks.map((task) => (
                <Card
                  key={task.id}
                  task={task}
                  done={isDoneStatus(list.statuses, column.status.slug)}
                  today={today}
                  href={taskHref?.(task)}
                  move={menuOf(task)}
                  subtasks={subtasksOf(task)}
                  notice={notice?.at === task.id ? notice.message : null}
                />
              ))}
            </Column>
          )),
        })}
        <DragOverlay dropAnimation={null}>
          {active === undefined ? null : renderCardPreview(active.title)}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
