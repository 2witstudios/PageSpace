import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      drives: { findFirst: vi.fn() },
    },
    select: vi.fn(),
    update: vi.fn(),
  },
  drives: { id: 'id', name: 'name', slug: 'slug', ownerId: 'ownerId', isTrashed: 'isTrashed', trashedAt: 'trashedAt', updatedAt: 'updatedAt' },
  eq: vi.fn((col, val) => ({ _op: 'eq', col, val })),
  and: vi.fn((...args) => ({ _op: 'and', args })),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { driveRepository } from '../drive-repository';
import { db, eq } from '@pagespace/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const driveRecord = {
  id: 'drive-1',
  name: 'My Drive',
  slug: 'my-drive',
  ownerId: 'user-1',
  isTrashed: false,
  trashedAt: null,
};

/** @scaffold - ORM chain mock until Drizzle query builder is abstracted */
function setupSelectChain(rows: unknown[]) {
  const whereFn = vi.fn().mockResolvedValue(rows);
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  vi.mocked(db.select).mockReturnValue({ from: fromFn } as unknown as ReturnType<typeof db.select>);
  return { whereFn };
}

/** @scaffold - ORM chain mock until Drizzle query builder is abstracted */
function setupUpdateChain(returnValue: unknown[]) {
  const returningFn = vi.fn().mockResolvedValue(returnValue);
  const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  vi.mocked(db.update).mockReturnValue({ set: setFn } as unknown as ReturnType<typeof db.update>);
  return { setFn, whereFn, returningFn };
}

// ---------------------------------------------------------------------------
// findById
// ---------------------------------------------------------------------------
describe('driveRepository.findById', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns drive record when found', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRecord as never);

    const result = await driveRepository.findById('drive-1');
    expect(result).toEqual(driveRecord);
  });

  it('returns undefined when drive not found', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined as never);

    const result = await driveRepository.findById('nonexistent');
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findByIdBasic
// ---------------------------------------------------------------------------
describe('driveRepository.findByIdBasic', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns basic drive info when found', async () => {
    const basicDrive = { id: 'drive-1', ownerId: 'user-1' };
    setupSelectChain([basicDrive]);

    const result = await driveRepository.findByIdBasic('drive-1');
    expect(result).toEqual(basicDrive);
  });

  it('returns null when drive not found', async () => {
    setupSelectChain([]);

    const result = await driveRepository.findByIdBasic('nonexistent');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findByIdAndOwner
// ---------------------------------------------------------------------------
describe('driveRepository.findByIdAndOwner', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns drive when found for given owner', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRecord as never);

    const result = await driveRepository.findByIdAndOwner('drive-1', 'user-1');
    expect(result).toEqual(driveRecord);
  });

  it('scopes query by both driveId and ownerId via eq()', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(driveRecord as never);

    await driveRepository.findByIdAndOwner('drive-1', 'user-1');

    expect(eq).toHaveBeenCalledWith('id', 'drive-1');
    expect(eq).toHaveBeenCalledWith('ownerId', 'user-1');
  });

  it('returns undefined when drive not found or wrong owner', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined as never);

    const result = await driveRepository.findByIdAndOwner('drive-1', 'wrong-user');
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// trash
// ---------------------------------------------------------------------------
describe('driveRepository.trash', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('sets isTrashed to true and trashedAt to a Date, scoped by driveId', async () => {
    /** @scaffold - ORM chain mock until Drizzle query builder is abstracted */
    const whereFn = vi.fn().mockResolvedValue(undefined);
    const setFn = vi.fn().mockReturnValue({ where: whereFn });
    vi.mocked(db.update).mockReturnValue({ set: setFn } as unknown as ReturnType<typeof db.update>);

    await driveRepository.trash('drive-1');

    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({ isTrashed: true }));
    const payload = setFn.mock.calls[0][0] as { trashedAt: Date };
    expect(payload.trashedAt).toBeInstanceOf(Date);
    expect(eq).toHaveBeenCalledWith('id', 'drive-1');
    expect(whereFn).toHaveBeenCalledWith({ _op: 'eq', col: 'id', val: 'drive-1' });
  });
});

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------
describe('driveRepository.restore', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns restored drive info', async () => {
    const restored = { id: 'drive-1', name: 'My Drive', slug: 'my-drive' };
    setupUpdateChain([restored]);

    const result = await driveRepository.restore('drive-1');
    expect(result).toEqual(restored);
  });

  it('calls update with isTrashed=false and null trashedAt, scoped by driveId', async () => {
    const { setFn, whereFn } = setupUpdateChain([{ id: 'drive-1', name: 'My Drive', slug: 'my-drive' }]);

    await driveRepository.restore('drive-1');
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
      isTrashed: false,
      trashedAt: null,
    }));
    expect(eq).toHaveBeenCalledWith('id', 'drive-1');
    expect(whereFn).toHaveBeenCalledWith({ _op: 'eq', col: 'id', val: 'drive-1' });
  });
});
