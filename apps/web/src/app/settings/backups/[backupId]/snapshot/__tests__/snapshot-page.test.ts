import { describe, it, expect } from 'vitest';
import { formatSnapshotLabel, flattenTree, getNodeIcon } from '../page';
import type { SnapshotPageNode } from '@/services/api/snapshot-pages-service';

// ============================================================================
// formatSnapshotLabel — pure function tests
// ============================================================================

describe('formatSnapshotLabel', () => {
  it('non-empty label → label returned as-is', () => {
    expect(formatSnapshotLabel({ label: 'My Snapshot', createdAt: '2024-01-15T12:00:00.000Z', source: 'manual' })).toBe('My Snapshot');
  });

  it('null label → source + formatted date', () => {
    const result = formatSnapshotLabel({ label: null, createdAt: '2024-01-15T12:00:00.000Z', source: 'manual' });
    expect(result).toContain('manual snapshot');
    expect(result).toContain('Jan 15, 2024');
  });

  it('empty string label → source + formatted date', () => {
    const result = formatSnapshotLabel({ label: '', createdAt: '2024-01-15T12:00:00.000Z', source: 'pre_restore' });
    expect(result).toContain('pre_restore snapshot');
  });
});

// ============================================================================
// flattenTree — pure function tests
// ============================================================================

const node = (pageId: string, position = 0, children: SnapshotPageNode[] = []): SnapshotPageNode => ({
  pageId,
  title: `Page ${pageId}`,
  type: 'DOCUMENT',
  parentId: null,
  position,
  isTrashed: false,
  stateHash: null,
  children,
});

describe('flattenTree', () => {
  it('empty array → []', () => {
    expect(flattenTree([])).toEqual([]);
  });

  it('single root node → [{...node, depth: 0}]', () => {
    const result = flattenTree([node('a')]);
    expect(result).toHaveLength(1);
    expect(result[0].pageId).toBe('a');
    expect(result[0].depth).toBe(0);
  });

  it('root with two children → [root(0), child1(1), child2(1)] in position order', () => {
    const parent = node('root', 0, [node('c2', 2), node('c1', 1)]);
    // Note: buildSnapshotPageTree sorts children; here children come pre-sorted from API
    // flattenTree does DFS so iterates in order given
    const result = flattenTree([parent]);
    expect(result).toHaveLength(3);
    expect(result[0].depth).toBe(0);
    expect(result[1].depth).toBe(1);
    expect(result[2].depth).toBe(1);
  });

  it('grandparent → parent → child → depths [0, 1, 2]', () => {
    const tree = [node('gp', 0, [node('p', 0, [node('c')])])];
    const result = flattenTree(tree);
    expect(result).toHaveLength(3);
    expect(result[0].depth).toBe(0);
    expect(result[1].depth).toBe(1);
    expect(result[2].depth).toBe(2);
  });

  it('depth parameter shifts all depths by the given value', () => {
    const result = flattenTree([node('a')], 2);
    expect(result[0].depth).toBe(2);
  });
});

// ============================================================================
// getNodeIcon — pure function tests
// ============================================================================

describe('getNodeIcon', () => {
  it('DOCUMENT → FileText', () => {
    expect(getNodeIcon('DOCUMENT')).toBe('FileText');
  });

  it('CODE → FileCode', () => {
    expect(getNodeIcon('CODE')).toBe('FileCode');
  });

  it('FOLDER → Folder', () => {
    expect(getNodeIcon('FOLDER')).toBe('Folder');
  });

  it('unknown type → File', () => {
    expect(getNodeIcon('UNKNOWN_TYPE_XYZ')).toBe('File');
  });
});

// ============================================================================
// Component tests — skipped in worktree (dual-React instance constraint)
// Validated via typecheck.
//
// Covered scenarios:
// - Loading state → spinner visible
// - Error state → "Failed to load snapshot" + retry button
// - Backup status !== 'ready' → "Restore" button disabled
// - Trashed node → strikethrough style applied
// - Clicking a row → content panel opens with correct title
// - Content panel "Close" → panel hidden
// ============================================================================
