import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecute = vi.fn();
const mockSelectWhere = vi.fn();
const mockInsertValues = vi.fn();
const mockTx = {
  execute: mockExecute,
  select: vi.fn(() => ({ from: vi.fn(() => ({ where: mockSelectWhere })) })),
  insert: vi.fn(() => ({ values: mockInsertValues })),
};
const mockTransaction = vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));

vi.mock('@pagespace/db/db', () => ({
  db: { transaction: (fn: (tx: typeof mockTx) => Promise<unknown>) => mockTransaction(fn) },
}));

vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  eq: vi.fn((...args: unknown[]) => ({ op: 'eq', args })),
  gt: vi.fn((...args: unknown[]) => ({ op: 'gt', args })),
  lt: vi.fn((...args: unknown[]) => ({ op: 'lt', args })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { raw: vi.fn() },
  ),
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'users.id' },
}));

vi.mock('@pagespace/db/schema/storage', () => ({
  pendingUploads: { id: 'id', userId: 'userId', fileSize: 'fileSize', expiresAt: 'expiresAt' },
}));

import { pendingUploadsRepository, reserveUploadSlot } from '../pending-uploads';

const NOW = new Date('2026-07-24T00:00:00.000Z');

describe('pendingUploadsRepository.reserveIfUnderLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransaction.mockImplementation(async (fn) => fn(mockTx));
    mockExecute.mockResolvedValue({ rows: [] });
  });

  it('reserveIfUnderLimit_withLiveCountUnderLimit_insertsAndReturnsTrue', async () => {
    mockSelectWhere.mockResolvedValue([{ count: 2 }]);
    mockInsertValues.mockResolvedValue(undefined);

    const result = await pendingUploadsRepository.reserveIfUnderLimit({
      id: 'job-1', userId: 'user-1', fileSize: 1024, maxConcurrentUploads: 3, now: NOW,
    });

    expect(result).toBe(true);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1', userId: 'user-1', fileSize: 1024 }),
    );
  });

  it('reserveIfUnderLimit_withLiveCountAtLimit_doesNotInsertAndReturnsFalse', async () => {
    mockSelectWhere.mockResolvedValue([{ count: 3 }]);

    const result = await pendingUploadsRepository.reserveIfUnderLimit({
      id: 'job-1', userId: 'user-1', fileSize: 1024, maxConcurrentUploads: 3, now: NOW,
    });

    expect(result).toBe(false);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('reserveIfUnderLimit_locksTheUsersRowBeforeCountingLiveRows', async () => {
    // #2225 review: the FOR UPDATE lock must be acquired BEFORE the count
    // query runs, or a concurrent transaction could still interleave between
    // them — the whole point of the lock is to serialize count+insert.
    mockSelectWhere.mockResolvedValue([{ count: 0 }]);
    const callOrder: string[] = [];
    mockExecute.mockImplementation(async () => { callOrder.push('lock'); return { rows: [] }; });
    mockSelectWhere.mockImplementation(async () => { callOrder.push('count'); return [{ count: 0 }]; });

    await pendingUploadsRepository.reserveIfUnderLimit({
      id: 'job-1', userId: 'user-1', fileSize: 1024, maxConcurrentUploads: 3, now: NOW,
    });

    expect(callOrder).toEqual(['lock', 'count']);
  });

  it('reserveIfUnderLimit_runsInsideATransaction', async () => {
    mockSelectWhere.mockResolvedValue([{ count: 0 }]);

    await pendingUploadsRepository.reserveIfUnderLimit({
      id: 'job-1', userId: 'user-1', fileSize: 1024, maxConcurrentUploads: 3, now: NOW,
    });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('reserveUploadSlot (shell)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransaction.mockImplementation(async (fn) => fn(mockTx));
  });

  it('reserveUploadSlot_delegatesToRepositoryWithGivenParams', async () => {
    mockSelectWhere.mockResolvedValue([{ count: 1 }]);

    const result = await reserveUploadSlot('job-1', 'user-1', 2048, 5, NOW);

    expect(result).toBe(true);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1', userId: 'user-1', fileSize: 2048 }),
    );
  });
});
