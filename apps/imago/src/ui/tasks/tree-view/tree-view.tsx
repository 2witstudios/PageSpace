'use client';

// The Tree view bound to a list's writes. Rows reorder within their own
// level by drag (@dnd-kit/sortable, pointer or keyboard) or by the row
// menu's Move up / Move down; either way it is useTaskList's move, so the
// new order shows at once and rolls back if the server refuses it. A row is
// never dragged into another level: nesting is a different edit.

import { useState, type ReactNode } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Task, TaskList } from '../task-model/task';
import { locate } from '../task-tree/task-tree';
import type { ActionResult, TaskActions } from '../use-tasks/use-tasks';
import { TaskRowMenu } from './task-row-menu';
import { renderTreeView, type RowDrag, type TaskNotice, type TreeSorting } from './tree-view.render';

export type TreeViewProps = {
  readonly list: TaskList;
  readonly actions: TaskActions;
  readonly expandedIds: readonly string[];
  readonly toggleExpanded: (taskId: string) => void;
  /** The viewer's own day, YYYY-MM-DD. */
  readonly today: string;
  readonly editable: boolean;
  /** Whether rows may be dragged: off while a filter hides some of a level's rows. */
  readonly reorderable: boolean;
  readonly taskHref?: (task: Task) => string;
};

function SortableRow({ id, render }: { readonly id: string; readonly render: (drag: RowDrag | null) => ReactNode }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id });
  return render({
    ref: setNodeRef,
    style: { transform: CSS.Transform.toString(transform) ?? undefined, transition: transition ?? undefined },
    handle: { ...attributes, ...listeners },
    dragging: isDragging,
  });
}

/**
 * Where a drop puts the dragged task among its siblings: the index of the
 * row it was dropped on, when both share a list; null for a drop elsewhere.
 */
export const dropIndex = (root: TaskList, activeId: string, overId: string | null): number | null => {
  if (overId === null || overId === activeId) return null;
  const from = locate(root, activeId);
  const to = locate(root, overId);
  if (from === undefined || to === undefined || from.list.pageId !== to.list.pageId) return null;
  return to.list.tasks.findIndex((task) => task.id === overId);
};

export function TreeView({ list, actions, expandedIds, toggleExpanded, today, editable, reorderable, taskHref }: TreeViewProps) {
  const [notice, setNotice] = useState<TaskNotice | null>(null);
  const report = (at: string) => (result: ActionResult) =>
    setNotice(result.ok ? null : { at, message: result.refusal });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const move = (taskId: string, toIndex: number) => {
    void actions.move(taskId, toIndex).then(report(taskId));
  };

  const rowMenu = (task: Task, holder: TaskList): ReactNode => {
    const at = holder.tasks.findIndex((entry) => entry.id === task.id);
    return (
      <TaskRowMenu
        title={task.title}
        href={taskHref?.(task)}
        moveUp={reorderable && at > 0 ? () => move(task.id, at - 1) : null}
        moveDown={reorderable && at < holder.tasks.length - 1 ? () => move(task.id, at + 1) : null}
        remove={() => {
          void actions.remove(task.id).then(report(task.id));
        }}
      />
    );
  };

  const sorting: TreeSorting = {
    level: (level, rows) => (
      <SortableContext items={level.tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
        {rows}
      </SortableContext>
    ),
    row: (task, render) => <SortableRow key={task.id} id={task.id} render={render} />,
  };

  const tree = renderTreeView({
    list,
    expandedIds,
    notice,
    today,
    editable,
    toggleExpanded,
    toggleComplete: (taskId) => {
      void actions.toggleComplete(taskId).then(report(taskId));
    },
    addTask: (listPageId, at, title) => {
      void actions.create(listPageId, { title }).then(report(at));
    },
    taskHref,
    rowMenu,
    sorting: reorderable ? sorting : undefined,
  });

  if (!editable || !reorderable) return tree;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={({ active, over }: DragEndEvent) => {
        const id = String(active.id);
        const index = dropIndex(list, id, over === null ? null : String(over.id));
        if (index !== null) move(id, index);
      }}
    >
      {tree}
    </DndContext>
  );
}
