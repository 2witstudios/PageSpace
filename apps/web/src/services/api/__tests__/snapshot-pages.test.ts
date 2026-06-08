import { describe, it, expect } from 'vitest';
import { buildSnapshotPageTree, sortSnapshotNodes } from '../snapshot-pages-service';
import type { SnapshotPageNode } from '../snapshot-pages-service';

// ============================================================================
// buildSnapshotPageTree — pure function tests (zero mocks, zero I/O)
// ============================================================================

const row = (
  pageId: string,
  parentId: string | null = null,
  position = 0,
  extra: Record<string, unknown> = {},
) => ({
  pageId,
  title: `Page ${pageId}`,
  type: 'document',
  parentId,
  position,
  isTrashed: false,
  stateHash: null,
  ...extra,
});

describe('buildSnapshotPageTree', () => {
  it('empty array → []', () => {
    expect(buildSnapshotPageTree([])).toEqual([]);
  });

  it('single root node (parentId: null) → one root, no children', () => {
    const result = buildSnapshotPageTree([row('a')]);
    expect(result).toHaveLength(1);
    expect(result[0].pageId).toBe('a');
    expect(result[0].children).toHaveLength(0);
  });

  it('parent + child → root contains child in .children', () => {
    const result = buildSnapshotPageTree([row('parent'), row('child', 'parent', 0)]);
    expect(result).toHaveLength(1);
    expect(result[0].pageId).toBe('parent');
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].pageId).toBe('child');
  });

  it('two children of same parent → sorted by position ascending', () => {
    const result = buildSnapshotPageTree([
      row('parent'),
      row('child2', 'parent', 2),
      row('child1', 'parent', 1),
    ]);
    expect(result[0].children[0].pageId).toBe('child1');
    expect(result[0].children[1].pageId).toBe('child2');
  });

  it('orphan row (parentId not in set) → placed at root level', () => {
    const result = buildSnapshotPageTree([row('orphan', 'nonexistent-parent')]);
    expect(result).toHaveLength(1);
    expect(result[0].pageId).toBe('orphan');
  });

  it('deep nesting: grandparent → parent → child → root length 1, depth 3', () => {
    const result = buildSnapshotPageTree([
      row('gp'),
      row('p', 'gp'),
      row('c', 'p'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].pageId).toBe('gp');
    expect(result[0].children[0].pageId).toBe('p');
    expect(result[0].children[0].children[0].pageId).toBe('c');
  });
});

// ============================================================================
// sortSnapshotNodes — pure function tests
// ============================================================================

const node = (pageId: string, position: number, children: SnapshotPageNode[] = []): SnapshotPageNode => ({
  pageId,
  title: null,
  type: 'document',
  parentId: null,
  position,
  isTrashed: false,
  stateHash: null,
  children,
});

describe('sortSnapshotNodes', () => {
  it('empty array → []', () => {
    expect(sortSnapshotNodes([])).toEqual([]);
  });

  it('sorts root nodes by position ascending', () => {
    const result = sortSnapshotNodes([node('b', 2), node('a', 1)]);
    expect(result[0].pageId).toBe('a');
    expect(result[1].pageId).toBe('b');
  });

  it('recurses into children', () => {
    const parent = node('parent', 0, [node('c2', 2), node('c1', 1)]);
    const result = sortSnapshotNodes([parent]);
    expect(result[0].children[0].pageId).toBe('c1');
    expect(result[0].children[1].pageId).toBe('c2');
  });

  it('does not mutate input array', () => {
    const input = [node('b', 2), node('a', 1)];
    sortSnapshotNodes(input);
    expect(input[0].pageId).toBe('b');
  });
});

// ============================================================================
// Route tests — see apps/web/src/app/api/drives/[driveId]/backups/[backupId]/pages/__tests__/route.test.ts
// ============================================================================
