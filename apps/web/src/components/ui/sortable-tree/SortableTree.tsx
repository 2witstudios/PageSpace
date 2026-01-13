"use client";

import { useState, useMemo, useCallback, useRef, ReactNode } from "react";
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
  closestCenter,
  MeasuringStrategy,
  UniqueIdentifier,
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

const measuring = {
  droppable: {
    strategy: MeasuringStrategy.Always,
  },
};

type SortableReturnType = ReturnType<typeof useSortable>;
type DropPosition = "before" | "after" | "inside" | null;

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
    dropPosition: DropPosition;
    projectedDepth: number | null;
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
}

export function SortableTree<T extends TreeItem>({
  items,
  collapsedIds = new Set(),
  indentationWidth = 24,
  onMove,
  renderItem,
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

  // Store the last valid projection in a ref to avoid race conditions
  // where projected becomes null right before handleDragEnd is called.
  // Updated synchronously during render to avoid useEffect lag.
  const projectedRef = useRef<Projection | null>(null);
  if (projected) {
    projectedRef.current = projected;
  }

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

      // Capture the projection before resetting state
      // Use ref to avoid race conditions where projected becomes null
      const finalProjection = projectedRef.current;

      setActiveId(null);
      setOverId(null);
      setOffsetLeft(0);
      projectedRef.current = null;

      if (over && active.id !== over.id && finalProjection && onMove) {
        onMove(String(active.id), String(over.id), finalProjection);
      }
    },
    [onMove]
  );

  const handleDragCancel = useCallback(() => {
    document.body.style.cursor = "";
    setActiveId(null);
    setOverId(null);
    setOffsetLeft(0);
    projectedRef.current = null;
  }, []);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      measuring={measuring}
      autoScroll={{
        // Disable horizontal auto-scroll (x: 0) while keeping vertical (y: 0.2 = 20% threshold)
        // This prevents unwanted horizontal scrolling when dragging right to change nesting depth
        threshold: { x: 0, y: 0.2 },
      }}
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
                // Derive dropPosition from projection - single source of truth
                dropPosition: overId === flatItem.item.id && projected ? projected.dropPosition : null,
                // Pass projectedDepth to over item for indicator positioning
                projectedDepth: overId === flatItem.item.id && projected ? projected.depth : null,
                projected: activeId === flatItem.item.id ? projected : null,
                handleProps,
                wrapperProps,
              })
            }
          </SortableTreeItem>
        ))}
      </SortableContext>
    </DndContext>
  );
}
