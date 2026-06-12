import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertChain = {
  values: vi.fn(),
  onConflictDoNothing: vi.fn(),
};
const updateChain = {
  set: vi.fn(),
  where: vi.fn(),
};
const deleteChain = {
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
    delete: vi.fn(() => deleteChain),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  sql: vi.fn(() => 'sql-fragment'),
}));

vi.mock('@pagespace/db/schema/ai-compaction', () => ({
  conversationCompactions: {
    conversationId: 'conversationId',
    summaryVersion: 'summaryVersion',
  },
}));

import { db } from '@pagespace/db/db';
import { getState, upsertState, invalidate } from '../compaction-repository';

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
  updateChain.set.mockReturnValue(updateChain);
  updateChain.where.mockResolvedValue({ rowCount: 1 });
  deleteChain.where.mockResolvedValue(undefined);
});

describe('getState', () => {
  it('returns the row when present', async () => {
    const row = { conversationId: 'conv-1', summaryVersion: 3 };
    selectChain.where.mockResolvedValueOnce([row]);

    await expect(getState('conv-1')).resolves.toBe(row);
  });

  it('returns null when no row exists', async () => {
    await expect(getState('conv-missing')).resolves.toBeNull();
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

  it('returns false when a concurrent insert won the race (rowCount 0)', async () => {
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

describe('invalidate', () => {
  it('deletes the compaction row for the conversation', async () => {
    await invalidate('conv-1');

    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(deleteChain.where).toHaveBeenCalledTimes(1);
  });
});
