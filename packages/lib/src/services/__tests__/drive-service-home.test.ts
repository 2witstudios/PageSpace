/**
 * drive-service Home-drive protection tests.
 *
 * Verifies that:
 * - trashDrive WHERE clause excludes kind='HOME' rows
 * - updateDrive WHERE clause excludes kind='HOME' rows when name is changing
 * - updateDrive allows drivePrompt-only updates on Home drives
 * - getHomeDrive fetches by ownerId + kind='HOME' with no isTrashed filter
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB — the update/query builder chain used by drive-service
vi.mock('@pagespace/db/db', () => ({
  db: {
    update: vi.fn(),
    query: {
      drives: {
        findFirst: vi.fn(),
      },
    },
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((col, val) => ({ op: 'eq', col, val })),
  ne: vi.fn((col, val) => ({ op: 'ne', col, val })),
  and: vi.fn((...args) => ({ op: 'and', args })),
  not: vi.fn((expr) => ({ op: 'not', expr })),
  inArray: vi.fn(),
  isNotNull: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  drives: {
    id: 'drives.id',
    name: 'drives.name',
    slug: 'drives.slug',
    ownerId: 'drives.ownerId',
    kind: 'drives.kind',
    isTrashed: 'drives.isTrashed',
  },
}));

vi.mock('@pagespace/lib/utils/utils', () => ({
  slugify: vi.fn((name: string) => name.toLowerCase().replace(/\s+/g, '-')),
}));

vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: {},
  pagePermissions: {},
}));

import { db } from '@pagespace/db/db';
import { eq, ne, and } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { trashDrive, updateDrive, getHomeDrive } from '../drive-service';

const mockDb = vi.mocked(db);

describe('trashDrive — Home kind guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const chainEnd = { returning: vi.fn().mockResolvedValue([]) };
    const whereChain = { where: vi.fn().mockReturnValue(chainEnd) };
    const setChain = { set: vi.fn().mockReturnValue(whereChain) };
    mockDb.update.mockReturnValue(setChain as unknown as ReturnType<typeof db.update>);
  });

  it('includes a ne(kind, HOME) condition in the WHERE clause', async () => {
    await trashDrive('drive-1');

    expect(ne).toHaveBeenCalledWith(drives.kind, 'HOME');
    expect(and).toHaveBeenCalled();

    const andArgs = vi.mocked(and).mock.calls[0];
    const hasEqId = andArgs.some(
      (arg) => typeof arg === 'object' && arg !== null && 'op' in arg && (arg as { op: string }).op === 'eq'
    );
    const hasNeKind = andArgs.some(
      (arg) => typeof arg === 'object' && arg !== null && 'op' in arg && (arg as { op: string }).op === 'ne'
    );
    expect(hasEqId).toBe(true);
    expect(hasNeKind).toBe(true);
  });

  it('returns null when no row is updated (i.e. the drive was Home)', async () => {
    const chainEnd = { returning: vi.fn().mockResolvedValue([]) };
    const whereChain = { where: vi.fn().mockReturnValue(chainEnd) };
    const setChain = { set: vi.fn().mockReturnValue(whereChain) };
    mockDb.update.mockReturnValue(setChain as unknown as ReturnType<typeof db.update>);

    const result = await trashDrive('home-drive-id');
    expect(result).toBeNull();
  });
});

describe('updateDrive — Home kind guard on name changes', () => {
  const makeUpdateChain = (returnRow: object | null = null) => {
    const chainEnd = { returning: vi.fn().mockResolvedValue(returnRow ? [returnRow] : []) };
    const whereChain = { where: vi.fn().mockReturnValue(chainEnd) };
    const setChain = { set: vi.fn().mockReturnValue(whereChain) };
    mockDb.update.mockReturnValue(setChain as unknown as ReturnType<typeof db.update>);
    return { setChain, whereChain, chainEnd };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes ne(kind, HOME) in WHERE when input.name is provided', async () => {
    makeUpdateChain();
    await updateDrive('drive-1', { name: 'New Name' });

    expect(ne).toHaveBeenCalledWith(drives.kind, 'HOME');
    expect(and).toHaveBeenCalled();

    const andArgs = vi.mocked(and).mock.calls[0];
    const hasNeKind = andArgs.some(
      (arg) => typeof arg === 'object' && arg !== null && 'op' in arg && (arg as { op: string }).op === 'ne'
    );
    expect(hasNeKind).toBe(true);
  });

  it('does NOT use and() when only drivePrompt is updated (no kind guard)', async () => {
    makeUpdateChain();
    vi.mocked(and).mockClear();
    vi.mocked(ne).mockClear();

    await updateDrive('drive-1', { drivePrompt: 'some context' });

    // With a drivePrompt-only update, ne() should not be called
    expect(ne).not.toHaveBeenCalledWith(drives.kind, 'HOME');
  });

  it('returns null when a name-change is a no-op (Home drive)', async () => {
    makeUpdateChain(null);
    const result = await updateDrive('home-drive-id', { name: 'Attempted Rename' });
    expect(result).toBeNull();
  });
});

describe('getHomeDrive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries by ownerId and kind=HOME', async () => {
    vi.mocked(mockDb.query.drives.findFirst).mockResolvedValue(undefined);
    await getHomeDrive('user-abc');

    expect(mockDb.query.drives.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.anything(),
      })
    );

    // The where clause should combine eq(ownerId, userId) AND eq(kind, 'HOME')
    expect(and).toHaveBeenCalled();
    const andArgs = vi.mocked(and).mock.calls[0];
    const eqCalls = vi.mocked(eq).mock.calls;
    const hasOwnerCheck = eqCalls.some(
      ([col, val]) => col === drives.ownerId && val === 'user-abc'
    );
    const hasKindCheck = eqCalls.some(
      ([col, val]) => col === drives.kind && val === 'HOME'
    );
    expect(hasOwnerCheck).toBe(true);
    expect(hasKindCheck).toBe(true);
  });

  it('does NOT filter by isTrashed', async () => {
    vi.mocked(mockDb.query.drives.findFirst).mockResolvedValue(undefined);
    await getHomeDrive('user-abc');

    const eqCalls = vi.mocked(eq).mock.calls;
    const hasIsTrashedFilter = eqCalls.some(
      ([col]) => col === drives.isTrashed
    );
    expect(hasIsTrashedFilter).toBe(false);
  });

  it('returns null when no Home drive found', async () => {
    vi.mocked(mockDb.query.drives.findFirst).mockResolvedValue(undefined);
    const result = await getHomeDrive('user-abc');
    expect(result).toBeNull();
  });

  it('returns the drive when found', async () => {
    const homeDrive = {
      id: 'home-1',
      name: 'Home',
      kind: 'HOME',
      ownerId: 'user-abc',
      slug: 'home',
      isTrashed: false,
      trashedAt: null,
      drivePrompt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.mocked(mockDb.query.drives.findFirst).mockResolvedValue(homeDrive as ReturnType<typeof mockDb.query.drives.findFirst> extends Promise<infer T> ? T : never);
    const result = await getHomeDrive('user-abc');
    expect(result?.kind).toBe('HOME');
    expect(result?.ownerId).toBe('user-abc');
  });
});
