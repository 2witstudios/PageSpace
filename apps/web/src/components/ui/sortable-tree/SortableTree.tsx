"use client";

import { useState, useMemo, useCallback, ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragEndEvent,
  DragMoveEvent,
  DragOverEvent,
  DragStartEvent,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  DragOverlay,
  closestCenter,
  MeasuringStrategy,
  UniqueIdentifier,
  DropAnimation,
  defaultDropAnimationSideEffects,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import {
  TreeItem,
  flattenTree,
  getProjection,
  removeChildrenOf,
  Projection,
} from "@/lib/tree/sortable-tree";
import { SortableTreeItem } from "./SortableTreeItem";
import { useSortable } from "@dnd-kit/sortable";

const dropAnimation: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: {
      active: {
        opacity: "0.5",
      },
    },
  }),
};

const measuring = {
  droppable: {
    strategy: MeasuringStrategy.Always,
  },
};

type SortableReturnType = ReturnType<typeof useSortable>;

export interface SortableTreeProps<T extends TreeItem> {
  items: T[];
  collapsedIds?: Set<string>;
  indentationWidth?: number;
  onMove?: (activeId: string, overId: string, projection: Projection) => void;
  renderItem: (props: {
    item: T;
    depth: number;
    isActive: boolean;
    isOver: boolean;
    projected: Projection | null;
    handleProps: {
      ref: (element: HTMLElement | null) => void;
      listeners: SortableReturnType["listeners"];
      attributes: SortableReturnType["attributes"];
    };
    wrapperProps: {
      ref: (element: HTMLElement | null) => void;
      style: React.CSSProperties;
    };
  }) => ReactNode;
  renderDragOverlay?: (item: T, depth: number) => ReactNode;
}

export function SortableTree<T extends TreeItem>({
  items,
  collapsedIds = new Set(),
  indentationWidth = 24,
  onMove,
  renderItem,
  renderDragOverlay,
}: SortableTreeProps<T>) {
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [overId, setOverId] = useState<UniqueIdentifier | null>(null);
  const [offsetLeft, setOffsetLeft] = useState(0);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Flatten tree for sortable context
  const flattenedItems = useMemo(
    () => flattenTree(items, null, 0, collapsedIds),
    [items, collapsedIds]
  );

  // During drag, remove children of the active item from sortable list
  const sortableItems = useMemo(() => {
    if (!activeId) return flattenedItems;
    return removeChildrenOf(flattenedItems, [activeId]);
  }, [flattenedItems, activeId]);

  const sortableIds = useMemo(
    () => sortableItems.map(({ item }) => item.id),
    [sortableItems]
  );

  // Calculate projection during drag
  const projected = useMemo(() => {
    if (!activeId || !overId) return null;
    return getProjection(sortableItems, activeId, overId, offsetLeft, indentationWidth);
  }, [sortableItems, activeId, overId, offsetLeft, indentationWidth]);

  // Get active item for overlay
  const activeItem = useMemo(
    () => flattenedItems.find(({ item }) => item.id === activeId),
    [flattenedItems, activeId]
  );

  const handleDragStart = useCallback(({ active }: DragStartEvent) => {
    setActiveId(active.id);
    setOverId(active.id);

    document.body.style.cursor = "grabbing";
  }, []);

  const handleDragMove = useCallback(({ delta }: DragMoveEvent) => {
    setOffsetLeft(delta.x);
  }, []);

  const handleDragOver = useCallback(({ over }: DragOverEvent) => {
    setOverId(over?.id ?? null);
  }, []);

  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      document.body.style.cursor = "";

      // Restore focus to the moved item after drag completes
      const movedElement = document.querySelector(
        `[data-tree-node-id="${active.id}"]`
      );
      if (movedElement instanceof HTMLElement) {
        requestAnimationFrame(() => movedElement.focus());
      }

      setActiveId(null);
      setOverId(null);
      setOffsetLeft(0);

      if (over && active.id !== over.id && projected && onMove) {
        onMove(String(active.id), String(over.id), projected);
      }
    },
    [projected, onMove]
  );

  const handleDragCancel = useCallback(() => {
    document.body.style.cursor = "";
    setActiveId(null);
    setOverId(null);
    setOffsetLeft(0);
  }, []);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      measuring={measuring}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        {sortableItems.map((flatItem) => (
          <SortableTreeItem
            key={flatItem.item.id}
            id={flatItem.item.id}
            depth={flatItem.depth}
            indentationWidth={indentationWidth}
            isActive={activeId === flatItem.item.id}
            isOver={overId === flatItem.item.id}
            projected={activeId === flatItem.item.id ? projected : null}
          >
            {(handleProps, wrapperProps) =>
              renderItem({
                item: flatItem.item,
                depth: flatItem.depth,
                isActive: activeId === flatItem.item.id,
                isOver: overId === flatItem.item.id,
                projected: activeId === flatItem.item.id ? projected : null,
                handleProps,
                wrapperProps,
              })
            }
          </SortableTreeItem>
        ))}
      </SortableContext>

      {typeof document !== "undefined" &&
        createPortal(
          <DragOverlay dropAnimation={dropAnimation}>
            {activeItem && renderDragOverlay ? (
              renderDragOverlay(activeItem.item, activeItem.depth)
            ) : activeItem ? (
              <div
                style={{
                  paddingLeft: activeItem.depth * indentationWidth,
                  opacity: 0.8,
                }}
              >
                {renderItem({
                  item: activeItem.item,
                  depth: activeItem.depth,
                  isActive: true,
                  isOver: false,
                  projected: null,
                  handleProps: {
                    ref: () => {},
                    listeners: undefined,
                    attributes: {
                      role: "button",
                      tabIndex: 0,
                      "aria-disabled": false,
                      "aria-pressed": false,
                      "aria-roledescription": "sortable",
                      "aria-describedby": "",
                    },
                  },
                  wrapperProps: {
                    ref: () => {},
                    style: {},
                  },
                })}
              </div>
            ) : null}
          </DragOverlay>,
          document.body
        )}
    </DndContext>
  );
}
