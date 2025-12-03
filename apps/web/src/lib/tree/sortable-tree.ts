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
 * Build a tree from flattened items
 */
export function buildTree<T extends TreeItem>(flattenedItems: FlattenedItem<T>[]): T[] {
  const root: T[] = [];
  const nodes: Record<string, T> = {};
  const childrenMap: Record<string, T[]> = {};

  for (const { item, parentId } of flattenedItems) {
    const clonedItem = { ...item, children: [] as T[] };
    nodes[item.id] = clonedItem;

    if (parentId === null) {
      root.push(clonedItem);
    } else {
      if (!childrenMap[parentId]) {
        childrenMap[parentId] = [];
      }
      childrenMap[parentId].push(clonedItem);
    }
  }

  // Assign children to their parents
  for (const [parentId, children] of Object.entries(childrenMap)) {
    if (nodes[parentId]) {
      nodes[parentId].children = children;
    }
  }

  return root;
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
 * Get the flattened index of all descendant IDs (for removing from sortable list during drag)
 */
export function getDescendantIds<T extends TreeItem>(items: T[], id: UniqueIdentifier): string[] {
  const item = findItemDeep(items, id);
  if (!item?.children?.length) return [];

  const ids: string[] = [];
  const collectIds = (children: T[]) => {
    for (const child of children) {
      ids.push(child.id);
      if (child.children?.length) {
        collectIds(child.children as T[]);
      }
    }
  };
  collectIds(item.children as T[]);
  return ids;
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

  return {
    depth,
    maxDepth,
    minDepth,
    parentId: getParentId(),
  };
}

/**
 * Apply a move operation to the tree
 * Returns a new flattened array with the item moved to its projected position
 */
export function applyProjection<T extends TreeItem>(
  items: FlattenedItem<T>[],
  activeId: UniqueIdentifier,
  overId: UniqueIdentifier,
  projection: Projection
): FlattenedItem<T>[] {
  const activeIndex = items.findIndex(({ item }) => item.id === activeId);
  const overIndex = items.findIndex(({ item }) => item.id === overId);
  const activeItem = items[activeIndex];

  // Move the item
  const newItems = arrayMove(items, activeIndex, overIndex);

  // Update the moved item's depth and parentId
  newItems[overIndex] = {
    ...activeItem,
    depth: projection.depth,
    parentId: projection.parentId,
  };

  return newItems;
}
