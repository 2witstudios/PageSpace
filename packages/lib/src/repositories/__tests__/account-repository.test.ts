import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@pagespace/db', () => {
  const mockDb = {
    query: {
      users: { findFirst: vi.fn() },
      drives: { findMany: vi.fn() },
    },
    select: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  };
  return {
    db: mockDb,
    users: { id: 'id', email: 'email', image: 'image' },
    drives: { id: 'id', name: 'name', ownerId: 'ownerId' },
    driveMembers: { driveId: 'driveId' },
    eq: vi.fn((_a, _b) => 'eq'),
    sql: Object.assign(
      vi.fn((parts: TemplateStringsArray) => ({ sql: parts.join('') })),
      { placeholder: vi.fn() }
    ),
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { accountRepository } from '../account-repository';
import { db } from '@pagespace/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @scaffold — ORM chain mock: db.select().from().where() */
function setupSelectChain(result: unknown[]) {
  const whereFn = vi.fn().mockResolvedValue(result);
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  vi.mocked(db.select).mockReturnValue({ from: fromFn } as unknown as ReturnType<typeof db.select>);
  return { whereFn, fromFn };
}

/** @scaffold — ORM chain mock: db.delete().where() */
function setupDeleteChain() {
  const whereFn = vi.fn().mockResolvedValue(undefined);
  vi.mocked(db.delete).mockReturnValue({ where: whereFn } as unknown as ReturnType<typeof db.delete>);
  return { whereFn };
}

// ---------------------------------------------------------------------------
// findById
// ---------------------------------------------------------------------------
describe('accountRepository.findById', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns user when found', async () => {
    const user = { id: 'user-1', email: 'test@example.com', image: null };
    vi.mocked(db.query.users.findFirst).mockResolvedValue(user as never);

    const result = await accountRepository.findById('user-1');
    expect(result).toEqual(user);
  });

  it('returns null when user not found', async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined as never);

    const result = await accountRepository.findById('nonexistent');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getOwnedDrives
// ---------------------------------------------------------------------------
describe('accountRepository.getOwnedDrives', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns owned drives', async () => {
    const drives = [{ id: 'drive-1', name: 'My Drive' }];
    vi.mocked(db.query.drives.findMany).mockResolvedValue(drives as never);

    const result = await accountRepository.getOwnedDrives('user-1');
    expect(result).toEqual(drives);
  });

  it('returns empty array when no owned drives', async () => {
    vi.mocked(db.query.drives.findMany).mockResolvedValue([] as never);

    const result = await accountRepository.getOwnedDrives('user-1');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getDriveMemberCount
// ---------------------------------------------------------------------------
describe('accountRepository.getDriveMemberCount', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('coerces string count from DB to number', async () => {
    setupSelectChain([{ count: '3' }]);

    const result = await accountRepository.getDriveMemberCount('drive-1');
    expect(result).toBe(3);
    expect(typeof result).toBe('number');
  });

  it('returns 0 when count is zero string', async () => {
    setupSelectChain([{ count: '0' }]);

    const result = await accountRepository.getDriveMemberCount('drive-1');
    expect(result).toBe(0);
    expect(typeof result).toBe('number');
  });

  it('returns 0 when result is empty (no rows)', async () => {
    setupSelectChain([]);

    const result = await accountRepository.getDriveMemberCount('drive-1');
    expect(result).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deleteDrive
// ---------------------------------------------------------------------------
describe('accountRepository.deleteDrive', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('resolves without error when DB succeeds', async () => {
    setupDeleteChain();

    await expect(accountRepository.deleteDrive('drive-1')).resolves.toBeUndefined();
  });

  it('propagates DB errors', async () => {
    const whereFn = vi.fn().mockRejectedValue(new Error('FK constraint'));
    vi.mocked(db.delete).mockReturnValue({ where: whereFn } as unknown as ReturnType<typeof db.delete>);

    await expect(accountRepository.deleteDrive('drive-1')).rejects.toThrow('FK constraint');
  });
});

// ---------------------------------------------------------------------------
// deleteUser
// ---------------------------------------------------------------------------
describe('accountRepository.deleteUser', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('resolves without error when DB succeeds', async () => {
    setupDeleteChain();

    await expect(accountRepository.deleteUser('user-1')).resolves.toBeUndefined();
  });

  it('propagates DB errors', async () => {
    const whereFn = vi.fn().mockRejectedValue(new Error('FK constraint'));
    vi.mocked(db.delete).mockReturnValue({ where: whereFn } as unknown as ReturnType<typeof db.delete>);

    await expect(accountRepository.deleteUser('user-1')).rejects.toThrow('FK constraint');
  });
});

// ---------------------------------------------------------------------------
// checkAndDeleteSoloDrives
// ---------------------------------------------------------------------------
describe('accountRepository.checkAndDeleteSoloDrives', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns empty multiMemberDriveNames when user has no owned drives', async () => {
    vi.mocked(db.transaction).mockImplementation(async (fn) => {
      const tx = {
        query: { drives: { findMany: vi.fn().mockResolvedValue([]) } },
        select: vi.fn(),
        delete: vi.fn(),
      };
      return fn(tx as unknown as Parameters<typeof fn>[0]);
    });

    const result = await accountRepository.checkAndDeleteSoloDrives('user-1');
    expect(result).toEqual({ multiMemberDriveNames: [] });
  });

  it('deletes solo drives and returns empty when all are solo', async () => {
    const deleteFn = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });

    vi.mocked(db.transaction).mockImplementation(async (fn) => {
      const tx = {
        query: {
          drives: { findMany: vi.fn().mockResolvedValue([{ id: 'drive-1', name: 'Solo Drive' }]) },
        },
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: '1' }]), // 1 member = solo
          }),
        }),
        delete: deleteFn,
      };
      return fn(tx as unknown as Parameters<typeof fn>[0]);
    });

    const result = await accountRepository.checkAndDeleteSoloDrives('user-1');
    expect(result).toEqual({ multiMemberDriveNames: [] });
  });

  it('returns multiMemberDriveNames when drives have multiple members', async () => {
    vi.mocked(db.transaction).mockImplementation(async (fn) => {
      const tx = {
        query: {
          drives: { findMany: vi.fn().mockResolvedValue([{ id: 'drive-1', name: 'Team Drive' }]) },
        },
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: '3' }]), // 3 members = multi
          }),
        }),
        delete: vi.fn(),
      };
      return fn(tx as unknown as Parameters<typeof fn>[0]);
    });

    const result = await accountRepository.checkAndDeleteSoloDrives('user-1');
    expect(result).toEqual({ multiMemberDriveNames: ['Team Drive'] });
  });

  it('handles mix of solo and multi-member drives - returns multi names and does not delete', async () => {
    vi.mocked(db.transaction).mockImplementation(async (fn) => {
      const tx = {
        query: {
          drives: {
            findMany: vi.fn().mockResolvedValue([
              { id: 'drive-1', name: 'Solo Drive' },
              { id: 'drive-2', name: 'Team Drive' },
            ]),
          },
        },
        select: vi.fn()
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ count: '1' }]),
            }),
          })
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ count: '5' }]),
            }),
          }),
        delete: vi.fn(),
      };
      return fn(tx as unknown as Parameters<typeof fn>[0]);
    });

    const result = await accountRepository.checkAndDeleteSoloDrives('user-1');
    expect(result.multiMemberDriveNames).toContain('Team Drive');
    expect(result.multiMemberDriveNames).not.toContain('Solo Drive');
  });
});
