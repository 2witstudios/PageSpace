import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      drives: { findFirst: vi.fn() },
    },
    select: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'id', name: 'name', slug: 'slug', ownerId: 'ownerId', isTrashed: 'isTrashed', trashedAt: 'trashedAt', updatedAt: 'updatedAt' },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((_a, _b) => 'eq'),
  and: vi.fn((...args) => ({ and: args })),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { driveRepository } from '../drive-repository';
import { db } from '@pagespace/db/db';

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

function setupSelectChain(rows: unknown[]) {
  // findByIdBasic uses array destructuring: const [drive] = await db.select()...where()
  // So the .where() must resolve directly to the rows array (no .limit())
  const whereFn = vi.fn().mockResolvedValue(rows);
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  vi.mocked(db.select).mockReturnValue({ from: fromFn } as unknown as ReturnType<typeof db.select>);
  return { whereFn };
}

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

  it('returns null/undefined when drive not found', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined as never);

    const result = await driveRepository.findById('nonexistent');
    // The repository casts undefined to DriveRecord | null; underlying value is undefined
    expect(result).toBeFalsy();
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

  it('returns null/undefined when drive not found or wrong owner', async () => {
    vi.mocked(db.query.drives.findFirst).mockResolvedValue(undefined as never);

    const result = await driveRepository.findByIdAndOwner('drive-1', 'wrong-user');
    expect(result).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// trash
// ---------------------------------------------------------------------------
describe('driveRepository.trash', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('sets isTrashed to true and trashedAt to a Date', async () => {
    const setFn = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update).mockReturnValue({ set: setFn } as unknown as ReturnType<typeof db.update>);

    await driveRepository.trash('drive-1');

    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({ isTrashed: true }));
    const payload = setFn.mock.calls[0][0] as { trashedAt: Date };
    expect(payload.trashedAt).toBeInstanceOf(Date);
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

  it('calls update with isTrashed=false and null trashedAt', async () => {
    const { setFn } = setupUpdateChain([{ id: 'drive-1', name: 'My Drive', slug: 'my-drive' }]);

    await driveRepository.restore('drive-1');
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
      isTrashed: false,
      trashedAt: null,
    }));
  });
});
