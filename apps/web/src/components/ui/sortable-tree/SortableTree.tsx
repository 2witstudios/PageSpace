"use client";

import { useState, useMemo, useCallback, ReactNode } from "react";
import {
  DndContext,
  DragEndEvent,
  DragMoveEvent,
  DragOverEvent,
  DragStartEvent,
  DragOverlay,
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
  selectedIds?: Set<string>;
  onMove?: (activeId: string, overId: string, projection: Projection) => void;
  onMultiMove?: (activeIds: string[], overId: string, projection: Projection) => void;
  onSelectionChange?: (ids: string[]) => void;
  renderItem: (props: {
    item: T;
    depth: number;
    isActive: boolean;
    isOver: boolean;
    dropPosition: DropPosition;
    projectedDepth: number | null;
    projected: Projection | null;
    flattenedIds: string[];
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
  renderDragOverlay?: (props: {
    items: T[];
    totalCount: number;
  }) => ReactNode;
}

export function SortableTree<T extends TreeItem>({
  items,
  collapsedIds = new Set(),
  indentationWidth = 24,
  selectedIds = new Set(),
  onMove,
  onMultiMove,
  onSelectionChange,
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

  // Flattened IDs for selection operations
  const flattenedIds = useMemo(
    () => flattenedItems.map(({ item }) => item.id),
    [flattenedItems]
  );

  // During drag, remove children of the active item from sortable list
  // Also remove children of all selected items if doing multi-select drag
  const sortableItems = useMemo(() => {
    if (!activeId) return flattenedItems;

    // If the active item is selected and there are multiple selections,
    // remove children of all selected items
    const isMultiDrag = selectedIds.has(String(activeId)) && selectedIds.size > 1;
    const idsToRemoveChildrenFrom = isMultiDrag
      ? Array.from(selectedIds)
      : [activeId];

    return removeChildrenOf(flattenedItems, idsToRemoveChildrenFrom);
  }, [flattenedItems, activeId, selectedIds]);

  const sortableIds = useMemo(
    () => sortableItems.map(({ item }) => item.id),
    [sortableItems]
  );

  // Calculate projection during drag
  const projected = useMemo(() => {
    if (!activeId || !overId) return null;
    return getProjection(sortableItems, activeId, overId, offsetLeft, indentationWidth);
  }, [sortableItems, activeId, overId, offsetLeft, indentationWidth]);

  // Get active item for DragOverlay
  const activeItem = useMemo(() => {
    if (!activeId) return null;
    return flattenedItems.find(({ item }) => item.id === activeId)?.item ?? null;
  }, [activeId, flattenedItems]);

  // Get all selected items for multi-drag overlay
  const selectedItems = useMemo(() => {
    if (!activeId || selectedIds.size <= 1) return activeItem ? [activeItem] : [];
    if (!selectedIds.has(String(activeId))) return activeItem ? [activeItem] : [];

    // Return selected items in their tree order
    return flattenedItems
      .filter(({ item }) => selectedIds.has(item.id))
      .map(({ item }) => item);
  }, [activeId, selectedIds, flattenedItems, activeItem]);

  const handleDragStart = useCallback(
    ({ active }: DragStartEvent) => {
      setActiveId(active.id);
      setOverId(active.id);

      // If dragging an item that's not selected, clear selection and select just this item
      if (!selectedIds.has(String(active.id))) {
        onSelectionChange?.([String(active.id)]);
      }

      document.body.style.cursor = "grabbing";
    },
    [selectedIds, onSelectionChange]
  );

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

      if (over && active.id !== over.id && projected) {
        const isMultiDrag = selectedIds.has(String(active.id)) && selectedIds.size > 1;

        if (isMultiDrag && onMultiMove) {
          // Multi-drag: move all selected items
          const selectedIdsArray = Array.from(selectedIds);
          onMultiMove(selectedIdsArray, String(over.id), projected);
        } else if (onMove) {
          // Single drag
          onMove(String(active.id), String(over.id), projected);
        }
      }
    },
    [projected, onMove, onMultiMove, selectedIds]
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
                flattenedIds,
                handleProps,
                wrapperProps,
              })
            }
          </SortableTreeItem>
        ))}
      </SortableContext>

      <DragOverlay dropAnimation={null}>
        {activeId && renderDragOverlay ? (
          renderDragOverlay({
            items: selectedItems as T[],
            totalCount: selectedItems.length,
          })
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
