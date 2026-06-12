import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertChain = {
  values: vi.fn(),
  onConflictDoNothing: vi.fn(),
  onConflictDoUpdate: vi.fn(),
};
const updateChain = {
  set: vi.fn(),
  where: vi.fn(),
};
const selectChain = {
  from: vi.fn(),
  where: vi.fn(),
};

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(() => selectChain),
    insert: vi.fn(() => insertChain),
    update: vi.fn(() => updateChain),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  and: vi.fn((...conditions: unknown[]) => ({ and: conditions })),
  sql: vi.fn(() => 'sql-fragment'),
}));

vi.mock('@pagespace/db/schema/ai-compaction', () => ({
  conversationCompactions: {
    conversationId: 'conversationId',
    source: 'source',
    pageId: 'pageId',
    summaryVersion: 'summaryVersion',
  },
}));

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { getState, upsertState, invalidate } from '../compaction-repository';

const PAGE_SCOPE = { source: 'page' as const, pageId: 'page-1' };
const GLOBAL_SCOPE = { source: 'global' as const };

const baseParams = {
  conversationId: 'conv-1',
  source: 'page' as const,
  pageId: 'page-1',
  summary: 'a summary',
  summaryTokens: 42,
  compactedUpToMessageId: 'm9',
  compactedUpToCreatedAt: new Date('2024-01-01T00:00:00Z'),
  summarizerModel: 'openai/gpt-test',
  lastCompactedAt: new Date('2024-01-02T00:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  selectChain.from.mockReturnValue(selectChain);
  selectChain.where.mockResolvedValue([]);
  insertChain.values.mockReturnValue(insertChain);
  insertChain.onConflictDoNothing.mockResolvedValue({ rowCount: 1 });
  insertChain.onConflictDoUpdate.mockResolvedValue(undefined);
  updateChain.set.mockReturnValue(updateChain);
  updateChain.where.mockResolvedValue({ rowCount: 1 });
});

describe('getState', () => {
  it('returns the row when present', async () => {
    const row = { conversationId: 'conv-1', summaryVersion: 3 };
    selectChain.where.mockResolvedValueOnce([row]);

    await expect(getState('conv-1', PAGE_SCOPE)).resolves.toBe(row);
  });

  it('returns null when no row exists', async () => {
    await expect(getState('conv-missing', GLOBAL_SCOPE)).resolves.toBeNull();
  });

  it('constrains the read to the scope source (and page for page-source)', async () => {
    await getState('conv-1', PAGE_SCOPE);

    const eqArgs = vi.mocked(eq).mock.calls.map(([, val]) => val);
    expect(eqArgs).toContain('conv-1');
    expect(eqArgs).toContain('page');
    expect(eqArgs).toContain('page-1');
  });

  it('does not filter by pageId for global scope', async () => {
    await getState('conv-1', GLOBAL_SCOPE);

    const eqArgs = vi.mocked(eq).mock.calls.map(([, val]) => val);
    expect(eqArgs).toContain('global');
    expect(eqArgs).not.toContain('page-1');
  });
});

describe('upsertState — first insert (expectedVersion null)', () => {
  it('inserts with summaryVersion 1 and onConflictDoNothing, returns true on success', async () => {
    const won = await upsertState({ ...baseParams, expectedVersion: null });

    expect(won).toBe(true);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', summaryVersion: 1 })
    );
    expect(insertChain.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it('returns false when a concurrent insert (or tombstone) won the race (rowCount 0)', async () => {
    insertChain.onConflictDoNothing.mockResolvedValueOnce({ rowCount: 0 });

    await expect(upsertState({ ...baseParams, expectedVersion: null })).resolves.toBe(false);
  });
});

describe('upsertState — version-guarded update (CAS)', () => {
  it('updates and returns true when the version matched a row', async () => {
    const won = await upsertState({ ...baseParams, expectedVersion: 5 });

    expect(won).toBe(true);
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.insert).not.toHaveBeenCalled();
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'a summary', summaryTokens: 42 })
    );
  });

  it('returns false when no row matched the expected version (lost race)', async () => {
    updateChain.where.mockResolvedValueOnce({ rowCount: 0 });

    await expect(upsertState({ ...baseParams, expectedVersion: 5 })).resolves.toBe(false);
  });
});

describe('invalidate — tombstone semantics', () => {
  it('writes an empty-state tombstone: PK-claiming insert, then scope-guarded clear+bump (never a delete)', async () => {
    await invalidate('conv-1', PAGE_SCOPE);

    // Step 1: claim the PK so a pending first-compaction insert loses
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        source: 'page',
        pageId: 'page-1',
        summary: '',
        summaryTokens: 0,
        compactedUpToMessageId: null,
        compactedUpToCreatedAt: null,
        summaryVersion: 1,
      })
    );
    expect(insertChain.onConflictDoNothing).toHaveBeenCalledTimes(1);

    // Step 2: scoped clear + version bump so a pending CAS update misses —
    // and so another scope's row holding the same PK is never touched.
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ summary: '', summaryTokens: 0 })
    );
  });

  it('global scope tombstones carry a null pageId', async () => {
    await invalidate('conv-2', GLOBAL_SCOPE);

    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-2', source: 'global', pageId: null })
    );
  });
});
