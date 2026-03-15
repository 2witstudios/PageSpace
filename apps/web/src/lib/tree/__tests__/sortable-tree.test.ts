import { describe, it, expect } from 'vitest';
import {
  flattenTree,
  buildTree,
  findItemDeep,
  removeItem,
  setProperty,
  countChildren,
  getDescendantIds,
  removeChildrenOf,
  getProjection,
  applyProjection,
  type TreeItem,
  type FlattenedItem,
} from '../sortable-tree';

// ── helpers ──────────────────────────────────────────────────────────────────

function item(id: string, children: TreeItem[] = [], collapsed?: boolean): TreeItem {
  return { id, children, collapsed };
}

function flat<T extends TreeItem>(
  item: T,
  parentId: string | null,
  depth: number,
  index: number
): FlattenedItem<T> {
  return { item, parentId, depth, index };
}

// ── flattenTree ───────────────────────────────────────────────────────────────

describe('flattenTree', () => {
  it('should return empty array for empty input', () => {
    expect(flattenTree([])).toEqual([]);
  });

  it('should flatten a single root item with no children', () => {
    const result = flattenTree([item('a')]);
    expect(result).toHaveLength(1);
    expect(result[0].item.id).toBe('a');
    expect(result[0].parentId).toBeNull();
    expect(result[0].depth).toBe(0);
    expect(result[0].index).toBe(0);
  });

  it('should flatten multiple root items preserving order', () => {
    const result = flattenTree([item('a'), item('b'), item('c')]);
    expect(result.map(r => r.item.id)).toEqual(['a', 'b', 'c']);
    expect(result.map(r => r.index)).toEqual([0, 1, 2]);
    expect(result.every(r => r.parentId === null)).toBe(true);
    expect(result.every(r => r.depth === 0)).toBe(true);
  });

  it('should include children of expanded items', () => {
    const tree = [item('parent', [item('child1'), item('child2')])];
    const result = flattenTree(tree);
    expect(result).toHaveLength(3);
    expect(result[0].item.id).toBe('parent');
    expect(result[1].item.id).toBe('child1');
    expect(result[1].parentId).toBe('parent');
    expect(result[1].depth).toBe(1);
    expect(result[2].item.id).toBe('child2');
    expect(result[2].parentId).toBe('parent');
    expect(result[2].depth).toBe(1);
  });

  it('should exclude children when parent id is in collapsedIds', () => {
    const tree = [item('parent', [item('child')])];
    const collapsed = new Set(['parent']);
    const result = flattenTree(tree, null, 0, collapsed);
    expect(result).toHaveLength(1);
    expect(result[0].item.id).toBe('parent');
  });

  it('should handle nested structures with correct depth', () => {
    const tree = [item('a', [item('b', [item('c')])])];
    const result = flattenTree(tree);
    expect(result).toHaveLength(3);
    expect(result[0].depth).toBe(0);
    expect(result[1].depth).toBe(1);
    expect(result[2].depth).toBe(2);
    expect(result[2].parentId).toBe('b');
  });

  it('should only collapse the collapsed subtree, not siblings', () => {
    const tree = [
      item('a', [item('a1'), item('a2')]),
      item('b', [item('b1')]),
    ];
    const collapsed = new Set(['a']);
    const result = flattenTree(tree, null, 0, collapsed);
    // a (no children), b, b1
    expect(result.map(r => r.item.id)).toEqual(['a', 'b', 'b1']);
  });

  it('should handle item with collapsed=true property but no collapsedIds set', () => {
    // collapsed property on the item itself is not used by flattenTree —
    // callers pass the collapsedIds set. Without it, children are visible.
    const parent = { id: 'p', children: [item('c')], collapsed: true };
    const result = flattenTree([parent]);
    expect(result).toHaveLength(2);
  });
});

// ── buildTree ─────────────────────────────────────────────────────────────────

describe('buildTree', () => {
  it('should return empty array for empty input', () => {
    expect(buildTree([])).toEqual([]);
  });

  it('should build a single-node tree', () => {
    const i = item('a');
    const result = buildTree([flat(i, null, 0, 0)]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
    expect(result[0].children).toEqual([]);
  });

  it('should build tree with one level of nesting', () => {
    const parent = item('parent', [item('child')]);
    const child = item('child');
    const flattened: FlattenedItem<TreeItem>[] = [
      flat(parent, null, 0, 0),
      flat(child, 'parent', 1, 0),
    ];
    const result = buildTree(flattened);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('parent');
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].id).toBe('child');
  });

  it('should produce empty children array on built items', () => {
    const flattened = [flat(item('a', [item('b')]), null, 0, 0)];
    // b is not in flattened — parent gets rebuilt with empty children
    const result = buildTree(flattened);
    expect(result[0].children).toEqual([]);
  });

  it('should roundtrip: flattenTree then buildTree', () => {
    const tree = [
      item('root', [
        item('child1', [item('grandchild')]),
        item('child2'),
      ]),
    ];
    const flattened = flattenTree(tree);
    const rebuilt = buildTree(flattened);

    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0].id).toBe('root');
    expect(rebuilt[0].children).toHaveLength(2);
    expect(rebuilt[0].children[0].id).toBe('child1');
    expect(rebuilt[0].children[0].children[0].id).toBe('grandchild');
    expect(rebuilt[0].children[1].id).toBe('child2');
  });

  it('should handle multiple root nodes', () => {
    const flattened = [
      flat(item('a'), null, 0, 0),
      flat(item('b'), null, 0, 1),
    ];
    const result = buildTree(flattened);
    expect(result).toHaveLength(2);
    expect(result.map(r => r.id)).toEqual(['a', 'b']);
  });
});

// ── findItemDeep ──────────────────────────────────────────────────────────────

describe('findItemDeep', () => {
  it('should return undefined for empty array', () => {
    expect(findItemDeep([], 'x')).toBeUndefined();
  });

  it('should find item at root level', () => {
    const tree = [item('a'), item('b')];
    expect(findItemDeep(tree, 'b')?.id).toBe('b');
  });

  it('should find item nested one level deep', () => {
    const tree = [item('root', [item('child')])];
    expect(findItemDeep(tree, 'child')?.id).toBe('child');
  });

  it('should find item nested multiple levels deep', () => {
    const tree = [item('a', [item('b', [item('c', [item('d')])])])];
    expect(findItemDeep(tree, 'd')?.id).toBe('d');
  });

  it('should return undefined for non-existent id', () => {
    const tree = [item('a', [item('b')])];
    expect(findItemDeep(tree, 'z')).toBeUndefined();
  });

  it('should find item in second subtree', () => {
    const tree = [
      item('a', [item('a1')]),
      item('b', [item('b1')]),
    ];
    expect(findItemDeep(tree, 'b1')?.id).toBe('b1');
  });
});

// ── removeItem ────────────────────────────────────────────────────────────────

describe('removeItem', () => {
  it('should return same array when id not found', () => {
    const tree = [item('a'), item('b')];
    const result = removeItem(tree, 'z');
    expect(result).toHaveLength(2);
  });

  it('should remove item from root level', () => {
    const tree = [item('a'), item('b'), item('c')];
    const result = removeItem(tree, 'b');
    expect(result.map(r => r.id)).toEqual(['a', 'c']);
  });

  it('should remove item from nested level', () => {
    const tree = [item('parent', [item('child1'), item('child2')])];
    const result = removeItem(tree, 'child1');
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].id).toBe('child2');
  });

  it('should handle empty input', () => {
    expect(removeItem([], 'a')).toEqual([]);
  });

  it('should remove a parent and leave siblings intact', () => {
    const tree = [item('a'), item('b', [item('b1')]), item('c')];
    const result = removeItem(tree, 'b');
    expect(result.map(r => r.id)).toEqual(['a', 'c']);
  });

  it('should remove deeply nested item', () => {
    const tree = [item('a', [item('b', [item('c')])])];
    const result = removeItem(tree, 'c');
    expect(result[0].children[0].children).toHaveLength(0);
  });
});

// ── setProperty ──────────────────────────────────────────────────────────────

describe('setProperty', () => {
  it('should set a property on root-level item', () => {
    const tree = [item('a'), item('b')];
    const result = setProperty(tree, 'a', 'collapsed', () => true);
    expect(result[0].collapsed).toBe(true);
    expect(result[1].collapsed).toBeUndefined();
  });

  it('should set a property on nested item', () => {
    const tree = [item('parent', [item('child')])];
    const result = setProperty(tree, 'child', 'collapsed', () => true);
    expect(result[0].children[0].collapsed).toBe(true);
  });

  it('should not mutate original tree', () => {
    const original = [item('a')];
    setProperty(original, 'a', 'collapsed', () => true);
    expect(original[0].collapsed).toBeUndefined();
  });

  it('should pass current value to setter', () => {
    const tree = [{ id: 'a', children: [], collapsed: false }];
    const result = setProperty(tree, 'a', 'collapsed', (v) => !v);
    expect(result[0].collapsed).toBe(true);
  });

  it('should return unchanged tree if id not found', () => {
    const tree = [item('a')];
    const result = setProperty(tree, 'z', 'collapsed', () => true);
    expect(result[0].collapsed).toBeUndefined();
  });
});

// ── countChildren ────────────────────────────────────────────────────────────

describe('countChildren', () => {
  it('should return 0 for empty array', () => {
    expect(countChildren([])).toBe(0);
  });

  it('should count leaf nodes', () => {
    expect(countChildren([item('a'), item('b'), item('c')])).toBe(3);
  });

  it('should count all descendants recursively', () => {
    const tree = [item('a', [item('b'), item('c', [item('d')])])];
    // countChildren increments for every item (leaf or not) and recurses into children:
    // a → has children → recurse([b, c], 0+1=1)
    //   b → no children → acc+1=2
    //   c → has children → recurse([d], 2+1=3)
    //     d → no children → acc+1=4
    expect(countChildren(tree)).toBe(4);
  });

  it('should count correctly with all leaves', () => {
    const tree = [item('a'), item('b'), item('c')];
    expect(countChildren(tree)).toBe(3);
  });

  it('should use passed count as starting value', () => {
    expect(countChildren([item('a')], 5)).toBe(6);
  });
});

// ── getDescendantIds ──────────────────────────────────────────────────────────

describe('getDescendantIds', () => {
  it('should return empty array for non-existent id', () => {
    expect(getDescendantIds([item('a')], 'z')).toEqual([]);
  });

  it('should return empty array for item with no children', () => {
    const tree = [item('a'), item('b')];
    expect(getDescendantIds(tree, 'a')).toEqual([]);
  });

  it('should return direct children ids', () => {
    const tree = [item('parent', [item('c1'), item('c2')])];
    expect(getDescendantIds(tree, 'parent')).toEqual(['c1', 'c2']);
  });

  it('should return all nested descendant ids', () => {
    const tree = [item('root', [item('a', [item('a1'), item('a2')]), item('b')])];
    const ids = getDescendantIds(tree, 'root');
    expect(ids).toContain('a');
    expect(ids).toContain('a1');
    expect(ids).toContain('a2');
    expect(ids).toContain('b');
    expect(ids).toHaveLength(4);
  });

  it('should work for nested item (not root)', () => {
    const tree = [item('root', [item('child', [item('grandchild')])])];
    expect(getDescendantIds(tree, 'child')).toEqual(['grandchild']);
  });
});

// ── removeChildrenOf ─────────────────────────────────────────────────────────

describe('removeChildrenOf', () => {
  it('should return same array if no ids match', () => {
    const root = item('a');
    const child = item('b');
    const flatList: FlattenedItem<TreeItem>[] = [
      flat(root, null, 0, 0),
      flat(child, null, 0, 1),
    ];
    const result = removeChildrenOf(flatList, ['z']);
    expect(result).toHaveLength(2);
  });

  it('should remove direct children of specified ids', () => {
    const root = item('parent');
    const child1 = item('child1');
    const child2 = item('child2');
    const sibling = item('sibling');
    const flatList: FlattenedItem<TreeItem>[] = [
      flat(root, null, 0, 0),
      flat(child1, 'parent', 1, 0),
      flat(child2, 'parent', 1, 1),
      flat(sibling, null, 0, 1),
    ];
    const result = removeChildrenOf(flatList, ['parent']);
    expect(result.map(r => r.item.id)).toEqual(['parent', 'sibling']);
  });

  it('should also remove grandchildren (transitive exclusion)', () => {
    const root = item('root');
    const child = item('child');
    const grandchild = item('grandchild');
    const flatList: FlattenedItem<TreeItem>[] = [
      flat(root, null, 0, 0),
      flat(child, 'root', 1, 0),
      flat(grandchild, 'child', 2, 0),
    ];
    const result = removeChildrenOf(flatList, ['root']);
    expect(result.map(r => r.item.id)).toEqual(['root']);
  });

  it('should handle multiple excluded ids', () => {
    const a = item('a');
    const a1 = item('a1');
    const b = item('b');
    const b1 = item('b1');
    const flatList: FlattenedItem<TreeItem>[] = [
      flat(a, null, 0, 0),
      flat(a1, 'a', 1, 0),
      flat(b, null, 0, 1),
      flat(b1, 'b', 1, 0),
    ];
    const result = removeChildrenOf(flatList, ['a', 'b']);
    expect(result.map(r => r.item.id)).toEqual(['a', 'b']);
  });
});

// ── getProjection ─────────────────────────────────────────────────────────────

describe('getProjection', () => {
  // Build a simple flat list: root → child1 → child2 (all at depth 0, no real nesting)
  function makeFlatList(): FlattenedItem<TreeItem>[] {
    return [
      flat(item('a'), null, 0, 0),
      flat(item('b'), null, 0, 1),
      flat(item('c'), null, 0, 2),
    ];
  }

  it('should return a projection with expected shape', () => {
    const flatList = makeFlatList();
    const result = getProjection(flatList, 'c', 'a', 0, 20);
    expect(result).toHaveProperty('depth');
    expect(result).toHaveProperty('maxDepth');
    expect(result).toHaveProperty('minDepth');
    expect(result).toHaveProperty('parentId');
    expect(result).toHaveProperty('dropPosition');
    expect(result).toHaveProperty('insertionIndex');
  });

  it('should set parentId to null when dropping at root level', () => {
    const flatList = makeFlatList();
    const result = getProjection(flatList, 'b', 'a', 0, 20);
    expect(result.parentId).toBeNull();
  });

  it('should set dropPosition to before when dragging upward', () => {
    const flatList = makeFlatList();
    // c is index 2, a is index 0: dragging c up over a → 'before'
    const result = getProjection(flatList, 'c', 'a', 0, 20);
    expect(result.dropPosition).toBe('before');
  });

  it('should set dropPosition to after when dragging downward', () => {
    const flatList = makeFlatList();
    // a is index 0, c is index 2: dragging a down over c → 'after'
    const result = getProjection(flatList, 'a', 'c', 0, 20);
    expect(result.dropPosition).toBe('after');
  });

  it('should clamp depth between minDepth and maxDepth', () => {
    const flatList = makeFlatList();
    // dragOffset very large tries to make depth huge
    const result = getProjection(flatList, 'b', 'c', 9999, 20);
    expect(result.depth).toBeLessThanOrEqual(result.maxDepth);
    expect(result.depth).toBeGreaterThanOrEqual(result.minDepth);
  });

  it('should set dropPosition to inside when dragged deeper than over item', () => {
    // To get 'inside': depth > overItem.depth.
    // Arrange: three items where overItem is at depth 0, and there is a previous
    // item so maxDepth >= 1. Drag c (index 2) over b (index 1) with large offset.
    // After arrayMove(items, 2, 1): newItems = [a, c, b]
    //   overItemIndex=1, previousItem=newItems[0]=a (depth 0) → maxDepth=1
    //   nextItem=newItems[2]=b (depth 0) → minDepth=0
    // projectedDepth = 0 + 9999 → clamped to maxDepth=1 → depth=1 > overItem.depth=0 → 'inside'
    const flatList: FlattenedItem<TreeItem>[] = [
      flat(item('a'), null, 0, 0),
      flat(item('b'), null, 0, 1),
      flat(item('c'), null, 0, 2),
    ];
    const result = getProjection(flatList, 'c', 'b', 9999, 1);
    expect(result.dropPosition).toBe('inside');
  });
});

// ── applyProjection ───────────────────────────────────────────────────────────

describe('applyProjection', () => {
  it('should move active item to over position', () => {
    const flatList: FlattenedItem<TreeItem>[] = [
      flat(item('a'), null, 0, 0),
      flat(item('b'), null, 0, 1),
      flat(item('c'), null, 0, 2),
    ];
    const projection = {
      depth: 0,
      maxDepth: 0,
      minDepth: 0,
      parentId: null,
      dropPosition: 'after' as const,
      insertionIndex: 2,
    };
    const result = applyProjection(flatList, 'a', 'c', projection);
    // a moves from index 0 to index 2 (c's position)
    expect(result[2].item.id).toBe('a');
  });

  it('should update depth on moved item', () => {
    const flatList: FlattenedItem<TreeItem>[] = [
      flat(item('a'), null, 0, 0),
      flat(item('b'), null, 0, 1),
      flat(item('child'), 'b', 1, 0),
    ];
    const projection = {
      depth: 1,
      maxDepth: 1,
      minDepth: 0,
      parentId: 'b',
      dropPosition: 'inside' as const,
      insertionIndex: 1,
    };
    const result = applyProjection(flatList, 'a', 'b', projection);
    const movedItem = result.find(r => r.item.id === 'a');
    expect(movedItem?.depth).toBe(1);
    expect(movedItem?.parentId).toBe('b');
  });

  it('should return array of same length', () => {
    const flatList: FlattenedItem<TreeItem>[] = [
      flat(item('a'), null, 0, 0),
      flat(item('b'), null, 0, 1),
    ];
    const projection = {
      depth: 0,
      maxDepth: 0,
      minDepth: 0,
      parentId: null,
      dropPosition: 'before' as const,
      insertionIndex: 0,
    };
    const result = applyProjection(flatList, 'b', 'a', projection);
    expect(result).toHaveLength(2);
  });
});
