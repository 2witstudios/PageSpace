import { describe, it, expect, vi, beforeEach } from 'vitest';
import { planPageRestoreOps } from '../restore-pages-service';
import type { RestoreDiff } from '../restore-diff-service';
import type { BackupPageRow } from '../restore-diff-service';

vi.mock('@pagespace/lib/services/page-content-store', () => ({
  readPageContent: vi.fn(),
}));
vi.mock('@pagespace/lib/services/page-version-service', () => ({
  createPageVersion: vi.fn(),
  computePageStateHash: vi.fn().mockReturnValue('hash-xyz'),
}));

import { readPageContent } from '@pagespace/lib/services/page-content-store';
import { createPageVersion } from '@pagespace/lib/services/page-version-service';
import { applyPageRestoreOps } from '../restore-pages-service';

// ============================================================================
// planPageRestoreOps — pure function tests (zero mocks, zero I/O)
// ============================================================================

const makeDiff = (overrides: Partial<RestoreDiff> = {}): RestoreDiff => ({
  toCreate: [],
  toOverwrite: [],
  toOrphan: [],
  unchanged: [],
  ...overrides,
});

const makeRow = (pageId: string, contentRef: string | null = 'ref-1'): BackupPageRow => ({
  pageId,
  title: 'Test Page',
  type: 'document',
  parentId: null,
  position: 0,
  isTrashed: false,
  pageVersionId: contentRef ? 'pv-1' : null,
  contentRef,
  stateHash: 'hash-1',
});

describe('planPageRestoreOps', () => {
  it('toCreate → op create with correct fields', () => {
    const diff = makeDiff({ toCreate: [{ pageId: 'p1', title: 'Page 1', type: 'document' }] });
    const map = new Map([['p1', makeRow('p1', 'ref-1')]]);
    const ops = planPageRestoreOps(diff, map);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: 'create',
      pageId: 'p1',
      title: 'Test Page',
      type: 'document',
      contentRef: 'ref-1',
    });
  });

  it('toOverwrite → op overwrite', () => {
    const diff = makeDiff({ toOverwrite: [{ pageId: 'p2', title: 'P2', type: 'document', currentHash: 'c', backupHash: 'b' }] });
    const map = new Map([['p2', makeRow('p2')]]);
    const ops = planPageRestoreOps(diff, map);
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe('overwrite');
    expect(ops[0].pageId).toBe('p2');
  });

  it('toOrphan → op soft-delete with only pageId', () => {
    const diff = makeDiff({ toOrphan: [{ pageId: 'p3', title: 'P3' }] });
    const ops = planPageRestoreOps(diff, new Map());
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ op: 'soft-delete', pageId: 'p3' });
  });

  it('unchanged → not in output', () => {
    const diff = makeDiff({ unchanged: [{ pageId: 'p4' }] });
    const ops = planPageRestoreOps(diff, new Map());
    expect(ops).toHaveLength(0);
  });

  it('empty diff → []', () => {
    expect(planPageRestoreOps(makeDiff(), new Map())).toHaveLength(0);
  });

  it('pageId in toCreate missing from backupPageMap → throws', () => {
    const diff = makeDiff({ toCreate: [{ pageId: 'missing', title: 'X', type: 'document' }] });
    expect(() => planPageRestoreOps(diff, new Map())).toThrow();
  });

  it('output length equals toCreate + toOverwrite + toOrphan', () => {
    const diff = makeDiff({
      toCreate: [{ pageId: 'a', title: 'A', type: 'document' }],
      toOverwrite: [{ pageId: 'b', title: 'B', type: 'document', currentHash: null, backupHash: null }],
      toOrphan: [{ pageId: 'c', title: 'C' }],
      unchanged: [{ pageId: 'd' }],
    });
    const map = new Map([['a', makeRow('a')], ['b', makeRow('b')]]);
    const ops = planPageRestoreOps(diff, map);
    expect(ops).toHaveLength(3);
  });

  it('calling twice with same args returns identical output (pure)', () => {
    const diff = makeDiff({
      toCreate: [{ pageId: 'x', title: 'X', type: 'document' }],
      toOrphan: [{ pageId: 'y', title: 'Y' }],
    });
    const map = new Map([['x', makeRow('x')]]);
    expect(planPageRestoreOps(diff, map)).toEqual(planPageRestoreOps(diff, map));
  });
});

// ============================================================================
// applyPageRestoreOps — effectful executor tests (mock tx, readPageContent, createPageVersion)
// ============================================================================

const makeTx = () => ({
  insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
  update: vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
  }),
});

describe('applyPageRestoreOps', () => {
  const driveId = 'drive_1';
  const userId = 'user_1';
  const backupId = 'backup_1';
  const changeGroupId = 'cg_1';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createPageVersion).mockResolvedValue({
      id: 'pv-new',
      contentRef: 'ref-new',
      contentSize: 100,
      compressed: false,
      storedSize: 100,
      compressionRatio: 1,
    });
  });

  it('create with non-null contentRef → readPageContent called, createPageVersion called with source restore', async () => {
    vi.mocked(readPageContent).mockResolvedValue('page content');
    const ops = [{ op: 'create' as const, pageId: 'p1', title: 'T', type: 'document', parentId: null, position: 0, contentRef: 'ref-1' }];
    const tx = makeTx();

    await applyPageRestoreOps(ops, driveId, userId, backupId, changeGroupId, tx as never);

    expect(readPageContent).toHaveBeenCalledWith('ref-1');
    expect(createPageVersion).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: 'p1', source: 'restore' }),
      expect.objectContaining({ tx }),
    );
  });

  it('create with null contentRef → readPageContent not called, createPageVersion called with empty content', async () => {
    const ops = [{ op: 'create' as const, pageId: 'p2', title: 'T', type: 'document', parentId: null, position: 0, contentRef: null }];
    const tx = makeTx();

    await applyPageRestoreOps(ops, driveId, userId, backupId, changeGroupId, tx as never);

    expect(readPageContent).not.toHaveBeenCalled();
    expect(createPageVersion).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: 'p2', content: '' }),
      expect.anything(),
    );
  });

  it('overwrite → tx.update called, createPageVersion called', async () => {
    vi.mocked(readPageContent).mockResolvedValue('content');
    const ops = [{ op: 'overwrite' as const, pageId: 'p3', title: 'T', type: 'document', parentId: null, position: 0, contentRef: 'ref-3' }];
    const tx = makeTx();

    await applyPageRestoreOps(ops, driveId, userId, backupId, changeGroupId, tx as never);

    expect(tx.update).toHaveBeenCalled();
    expect(createPageVersion).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: 'p3', source: 'restore' }),
      expect.anything(),
    );
  });

  it('soft-delete → tx.update sets isTrashed true, readPageContent and createPageVersion not called', async () => {
    const ops = [{ op: 'soft-delete' as const, pageId: 'p4' }];
    const tx = makeTx();

    await applyPageRestoreOps(ops, driveId, userId, backupId, changeGroupId, tx as never);

    expect(tx.update).toHaveBeenCalled();
    expect(readPageContent).not.toHaveBeenCalled();
    expect(createPageVersion).not.toHaveBeenCalled();
  });

  it('readPageContent rejects → applyPageRestoreOps rejects (no swallowing)', async () => {
    vi.mocked(readPageContent).mockRejectedValue(new Error('S3 error'));
    const ops = [{ op: 'create' as const, pageId: 'p5', title: 'T', type: 'document', parentId: null, position: 0, contentRef: 'ref-5' }];
    const tx = makeTx();

    await expect(
      applyPageRestoreOps(ops, driveId, userId, backupId, changeGroupId, tx as never),
    ).rejects.toThrow('S3 error');
  });
});
