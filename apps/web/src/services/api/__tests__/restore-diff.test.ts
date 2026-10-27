import { describe, it, expect } from 'vitest';
import { computeRestoreDiff } from '../restore-diff-service';

const bp = (
  pageId: string,
  stateHash: string | null = 'hash-1',
  title = 'Page',
  type = 'document',
  parentId: string | null = null,
  position: number | null = 0,
) => ({ pageId, stateHash, title, type, parentId, position });

const cp = (
  id: string,
  stateHash: string | null = 'hash-1',
  title = 'Page',
  type = 'document',
  parentId: string | null = null,
  position: number | null = 0,
) => ({ id, stateHash, title, type, parentId, position });

describe('computeRestoreDiff', () => {
  it('returns all empty arrays for empty inputs', () => {
    const result = computeRestoreDiff([], []);
    expect(result.toCreate).toEqual([]);
    expect(result.toOverwrite).toEqual([]);
    expect(result.toOrphan).toEqual([]);
    expect(result.unchanged).toEqual([]);
  });

  it('page only in backupPages → toCreate', () => {
    const result = computeRestoreDiff([bp('p1')], []);
    expect(result.toCreate).toHaveLength(1);
    expect(result.toCreate[0].pageId).toBe('p1');
    expect(result.toOverwrite).toHaveLength(0);
    expect(result.toOrphan).toHaveLength(0);
    expect(result.unchanged).toHaveLength(0);
  });

  it('page only in currentPages → toOrphan', () => {
    const result = computeRestoreDiff([], [cp('p1')]);
    expect(result.toOrphan).toHaveLength(1);
    expect(result.toOrphan[0].pageId).toBe('p1');
    expect(result.toCreate).toHaveLength(0);
    expect(result.toOverwrite).toHaveLength(0);
    expect(result.unchanged).toHaveLength(0);
  });

  it('page in both with identical non-null stateHash → unchanged', () => {
    const result = computeRestoreDiff([bp('p1', 'same')], [cp('p1', 'same')]);
    expect(result.unchanged).toHaveLength(1);
    expect(result.unchanged[0].pageId).toBe('p1');
    expect(result.toCreate).toHaveLength(0);
    expect(result.toOverwrite).toHaveLength(0);
    expect(result.toOrphan).toHaveLength(0);
  });

  it('page in both with differing stateHashes → toOverwrite with both hashes', () => {
    const result = computeRestoreDiff([bp('p1', 'backup-h')], [cp('p1', 'current-h')]);
    expect(result.toOverwrite).toHaveLength(1);
    expect(result.toOverwrite[0].pageId).toBe('p1');
    expect(result.toOverwrite[0].backupHash).toBe('backup-h');
    expect(result.toOverwrite[0].currentHash).toBe('current-h');
    expect(result.unchanged).toHaveLength(0);
  });

  it('page in both where backupHash is null → toOverwrite (safe default)', () => {
    const result = computeRestoreDiff([bp('p1', null)], [cp('p1', 'current-h')]);
    expect(result.toOverwrite).toHaveLength(1);
    expect(result.toOverwrite[0].backupHash).toBeNull();
    expect(result.toOverwrite[0].currentHash).toBe('current-h');
  });

  it('page in both where currentHash is null → toOverwrite (safe default)', () => {
    const result = computeRestoreDiff([bp('p1', 'backup-h')], [cp('p1', null)]);
    expect(result.toOverwrite).toHaveLength(1);
    expect(result.toOverwrite[0].currentHash).toBeNull();
  });

  it('page in both where both hashes are null → toOverwrite', () => {
    const result = computeRestoreDiff([bp('p1', null)], [cp('p1', null)]);
    expect(result.toOverwrite).toHaveLength(1);
  });

  it('total item count equals union of all unique pageIds (no duplicates, no gaps)', () => {
    const backupPages = [bp('p1', 'h1'), bp('p2', 'h2'), bp('p3', 'h3')];
    const currentPages = [cp('p2', 'different'), cp('p3', 'h3'), cp('p4', 'h4')];
    const result = computeRestoreDiff(backupPages, currentPages);

    const allIds = new Set([
      ...backupPages.map(p => p.pageId),
      ...currentPages.map(p => p.id),
    ]);
    const covered = [
      ...result.toCreate.map(p => p.pageId),
      ...result.toOverwrite.map(p => p.pageId),
      ...result.toOrphan.map(p => p.pageId),
      ...result.unchanged.map(p => p.pageId),
    ];

    expect(covered).toHaveLength(allIds.size);
    expect(new Set(covered)).toEqual(allIds);
  });

  it('calling twice with same args returns structurally equal output (pure)', () => {
    const backupPages = [bp('p1', 'h1'), bp('p2', null)];
    const currentPages = [cp('p1', 'h1'), cp('p3', 'h3')];
    expect(computeRestoreDiff(backupPages, currentPages))
      .toEqual(computeRestoreDiff(backupPages, currentPages));
  });
});
