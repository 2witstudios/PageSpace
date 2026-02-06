/**
 * Sortable Tree Utilities
 * Ported from dnd-kit SortableTree example
 * https://github.com/clauderic/dnd-kit/tree/master/stories/3%20-%20Examples/Tree
 */

import type { UniqueIdentifier } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';

// Generic tree item interface - any item with id and children
export interface TreeItem {
  id: string;
  children: TreeItem[];
  collapsed?: boolean;
}

// Flattened representation for sortable operations
export interface FlattenedItem<T extends TreeItem = TreeItem> {
  item: T;
  parentId: string | null;
  depth: number;
  index: number;
}

/**
 * Flatten a tree into a single array for SortableContext
 * Only includes visible items (respects collapsed state)
 */
export function flattenTree<T extends TreeItem>(
  items: T[],
  parentId: string | null = null,
  depth: number = 0,
  collapsedIds: Set<string> = new Set()
): FlattenedItem<T>[] {
  return items.reduce<FlattenedItem<T>[]>((acc, item, index) => {
    const flatItem: FlattenedItem<T> = {
      item,
      parentId,
      depth,
      index,
    };
    acc.push(flatItem);

    // Only add children if this item is not collapsed
    if (item.children?.length && !collapsedIds.has(item.id)) {
      acc.push(...flattenTree(item.children as T[], item.id, depth + 1, collapsedIds));
    }

    return acc;
  }, []);
}

/**
 * Find an item in the tree by ID
 */
export function findItemDeep<T extends TreeItem>(
  items: T[],
  itemId: UniqueIdentifier
): T | undefined {
  for (const item of items) {
    if (item.id === itemId) {
      return item;
    }

    if (item.children?.length) {
      const child = findItemDeep(item.children as T[], itemId);
      if (child) {
        return child as T;
      }
    }
  }

  return undefined;
}

/**
 * Remove an item from the tree by ID
 */
export function removeItem<T extends TreeItem>(items: T[], id: UniqueIdentifier): T[] {
  const newItems: T[] = [];

  for (const item of items) {
    if (item.id === id) {
      continue;
    }

    if (item.children?.length) {
      const newItem = { ...item, children: removeItem(item.children as T[], id) };
      newItems.push(newItem as T);
    } else {
      newItems.push(item);
    }
  }

  return newItems;
}

/**
 * Set a property on an item in the tree
 */
export function setProperty<T extends TreeItem, K extends keyof T>(
  items: T[],
  id: UniqueIdentifier,
  property: K,
  setter: (value: T[K]) => T[K]
): T[] {
  return items.map((item) => {
    if (item.id === id) {
      return { ...item, [property]: setter(item[property]) };
    }

    if (item.children?.length) {
      return {
        ...item,
        children: setProperty(item.children as T[], id, property, setter),
      };
    }

    return item;
  });
}

/**
 * Count all descendants of an item
 */
export function countChildren<T extends TreeItem>(items: T[], count = 0): number {
  return items.reduce((acc, item) => {
    if (item.children?.length) {
      return countChildren(item.children as T[], acc + 1);
    }
    return acc + 1;
  }, count);
}

/**
 * Remove children of specific IDs from flattened array
 */
export function removeChildrenOf<T extends TreeItem>(
  items: FlattenedItem<T>[],
  ids: UniqueIdentifier[]
): FlattenedItem<T>[] {
  const excludeParentIds = new Set<UniqueIdentifier>(ids);

  return items.filter((item) => {
    if (item.parentId && excludeParentIds.has(item.parentId)) {
      // Also exclude children of excluded items
      excludeParentIds.add(item.item.id);
      return false;
    }
    return true;
  });
}

// Projection types
export interface Projection {
  depth: number;
  maxDepth: number;
  minDepth: number;
  parentId: string | null;
  dropPosition: 'before' | 'after' | 'inside';
  insertionIndex: number;
}

/**
 * Calculate the projected position of a dragged item
 * This determines where the item will be inserted based on cursor offset
 */
export function getProjection<T extends TreeItem>(
  items: FlattenedItem<T>[],
  activeId: UniqueIdentifier,
  overId: UniqueIdentifier,
  dragOffset: number,
  indentationWidth: number
): Projection {
  const overItemIndex = items.findIndex(({ item }) => item.id === overId);
  const activeItemIndex = items.findIndex(({ item }) => item.id === activeId);
  const activeItem = items[activeItemIndex];
  const overItem = items[overItemIndex];

  // Calculate new depth based on horizontal offset
  const projectedDepth = activeItem.depth + Math.round(dragOffset / indentationWidth);

  // Get constraints based on neighboring items
  const newItems = arrayMove(items, activeItemIndex, overItemIndex);
  const previousItem = newItems[overItemIndex - 1];
  const nextItem = newItems[overItemIndex + 1];

  // Max depth: previous item's depth + 1 (can be child of previous)
  const maxDepth = previousItem ? previousItem.depth + 1 : 0;

  // Min depth: next item's depth (can't be shallower than next sibling)
  const minDepth = nextItem ? nextItem.depth : 0;

  // Clamp projected depth
  const depth = Math.min(Math.max(projectedDepth, minDepth), maxDepth);

  // Find the parent at this depth
  function getParentId(): string | null {
    if (depth === 0 || !previousItem) {
      return null;
    }

    if (depth === previousItem.depth) {
      return previousItem.parentId;
    }

    if (depth > previousItem.depth) {
      return previousItem.item.id;
    }

    // Find an ancestor at the correct depth
    const newParent = newItems
      .slice(0, overItemIndex)
      .reverse()
      .find((item) => item.depth === depth - 1);

    return newParent?.item.id ?? null;
  }

  const parentId = getParentId();

  // Calculate drop position and insertion index
  // This is the source of truth for visual indicators AND actual placement
  let dropPosition: 'before' | 'after' | 'inside';

  if (depth > overItem.depth) {
    // Dropping deeper than the over item = inside it (as first child)
    dropPosition = 'inside';
  } else if (activeItemIndex < overItemIndex) {
    // Dragging down = dropping after the over item
    dropPosition = 'after';
  } else {
    // Dragging up = dropping before the over item
    dropPosition = 'before';
  }

  // Calculate insertion index among siblings at the new parent
  // This counts how many siblings come before our insertion point
  let insertionIndex = 0;
  for (let i = 0; i < overItemIndex; i++) {
    if (newItems[i].parentId === parentId && newItems[i].item.id !== activeId) {
      insertionIndex++;
    }
  }
  // For "after" drops, we insert after the over item if it's a sibling
  if (dropPosition === 'after' && overItem.parentId === parentId) {
    insertionIndex++;
  }

  return {
    depth,
    maxDepth,
    minDepth,
    parentId,
    dropPosition,
    insertionIndex,
  };
}

