/**
 * @scaffold - ORM chain mocks present. Pending drive-role-repository seam
 * extraction to replace select().from().where() and update/insert chains
 * with a mockable repository interface.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      drives: { findFirst: vi.fn() },
      driveRoles: { findMany: vi.fn(), findFirst: vi.fn() },
      driveMembers: { findFirst: vi.fn() },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{}]),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{}]),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
    transaction: vi.fn(),
  },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'drives.id', name: 'drives.name', slug: 'drives.slug', ownerId: 'drives.ownerId' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveRoles: { id: 'dr.id', driveId: 'dr.driveId', name: 'dr.name', description: 'dr.description', color: 'dr.color', isDefault: 'dr.isDefault', permissions: 'dr.permissions', position: 'dr.position', updatedAt: 'dr.updatedAt' },
  driveMembers: { driveId: 'dm.driveId', userId: 'dm.userId', role: 'dm.role', acceptedAt: 'dm.acceptedAt' },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  asc: vi.fn((a) => ({ op: 'asc', a })),
  inArray: vi.fn((a, b) => ({ op: 'inArray', a, b })),
  isNotNull: vi.fn((a) => ({ op: 'isNotNull', a })),
  sql: Object.assign(
    vi.fn((strings: unknown, ...values: unknown[]) => ({ strings, values })),
    {
      join: vi.fn((parts: unknown[], sep: unknown) => ({ parts, sep })),
      identifier: vi.fn((name: string) => ({ identifier: name })),
    }
  ),
}));

import { db } from '@pagespace/db/db';
import {
  checkDriveAccessForRoles,
  listDriveRoles,
  getRoleById,
  createDriveRole,
  updateDriveRole,
  deleteDriveRole,
  reorderDriveRoles,
  validateRolePermissions,
  validateDriveWidePermissions,
  mergeRolePermissionsPatch,
} from '../drive-role-service';

type MockFn = ReturnType<typeof vi.fn>;
type MockDb = {
  query: {
    drives: { findFirst: MockFn };
    driveRoles: { findMany: MockFn; findFirst: MockFn };
    driveMembers: { findFirst: MockFn };
  };
  select: MockFn;
  insert: MockFn;
  update: MockFn;
  delete: MockFn;
  transaction: MockFn;
};
const mockDb = db as unknown as MockDb;

// Builds a mock transaction client (`tx`) shared by createDriveRole,
// updateDriveRole, and reorderDriveRoles tests. `tx.select().from().where()`
// resolves directly to `selectRows` (the plain, unordered read used by
// createDriveRole's non-default path) and also chains `.for('update')`
// (single-row lock) or `.orderBy(asc(id)).for('update')` (ordered drive-wide
// lock, taken whenever isDefault is involved) — both resolving to the same
// `selectRows`. `tx.update().set().where()` resolves each successive call to
// the next entry in `updateResults` (`returning()` resolves; a plain
// no-`returning()` update — e.g. unsetting other defaults — resolves
// `where()` itself to `undefined`). `tx.insert().values().returning()`
// resolves to `insertResult`.
function makeTx(
  selectRows: unknown[],
  updateResults: Array<unknown[] | undefined> = [],
  insertResult?: unknown[]
) {
  const forMock = vi.fn().mockResolvedValue(selectRows);
  const orderByMock = vi.fn(() => ({ for: forMock }));
  const selectWhereChain = {
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(selectRows).then(resolve, reject),
    for: forMock,
    orderBy: orderByMock,
  };
  let updateCall = 0;
  const updateMock = vi.fn(() => ({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(() => {
        const result = updateResults[updateCall++];
        if (result === undefined) return Promise.resolve(undefined);
        return { returning: vi.fn().mockResolvedValue(result) };
      }),
    }),
  }));
  const insertMock = vi.fn(() => ({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(insertResult ?? []),
    }),
  }));
  const selectMock = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => selectWhereChain),
    })),
  }));
  const executeMock = vi.fn().mockResolvedValue(undefined);
  return {
    select: selectMock,
    update: updateMock,
    insert: insertMock,
    execute: executeMock,
    forMock,
    orderByMock,
  };
}

describe('drive-role-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkDriveAccessForRoles', () => {
    // checkDriveAccessForRoles delegates to the centralized getDriveAccessLevel
    // (packages/lib/src/permissions/drive-access-level.ts), which resolves the
    // drive via db.query.drives.findFirst and membership via a gated
    // db.select().from(driveMembers) — mirrors drive-member-service's own
    // checkDriveAccess test setup.
    it('should return no access when drive not found', async () => {
      mockDb.query.drives.findFirst.mockResolvedValueOnce(null);

      const result = await checkDriveAccessForRoles('drive-1', 'user-1');
      expect(result.drive).toBeNull();
      expect(result.isOwner).toBe(false);
    });

    it('should return owner access', async () => {
      mockDb.query.drives.findFirst.mockResolvedValueOnce({
        id: 'drive-1', name: 'My Drive', slug: 'my-drive', ownerId: 'user-1',
      });

      const result = await checkDriveAccessForRoles('drive-1', 'user-1');
      expect(result.isOwner).toBe(true);
      expect(result.isAdmin).toBe(true);
      expect(result.drive!.name).toBe('My Drive');
    });

    it('should return admin for ADMIN member', async () => {
      mockDb.query.drives.findFirst.mockResolvedValueOnce({
        id: 'drive-1', name: 'My Drive', slug: 'my-drive', ownerId: 'other',
      });
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ role: 'ADMIN' }]),
          }),
        }),
      });

      const result = await checkDriveAccessForRoles('drive-1', 'user-1');
      expect(result.isAdmin).toBe(true);
      expect(result.isMember).toBe(true);
    });

    it('should return non-admin for MEMBER role', async () => {
      mockDb.query.drives.findFirst.mockResolvedValueOnce({
        id: 'drive-1', name: 'My Drive', slug: 'my-drive', ownerId: 'other',
      });
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ role: 'MEMBER' }]),
          }),
        }),
      });

      const result = await checkDriveAccessForRoles('drive-1', 'user-1');
      expect(result.isAdmin).toBe(false);
      expect(result.isMember).toBe(true);
    });

    it('should return non-member when no membership', async () => {
      mockDb.query.drives.findFirst.mockResolvedValueOnce({
        id: 'drive-1', name: 'My Drive', slug: 'my-drive', ownerId: 'other',
      });
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await checkDriveAccessForRoles('drive-1', 'user-1');
      expect(result.isMember).toBe(false);
      expect(result.drive).not.toBeNull();
    });
  });

  describe('listDriveRoles', () => {
    it('should return roles', async () => {
      const roles = [{ id: 'r1', name: 'Editor' }, { id: 'r2', name: 'Viewer' }];
      mockDb.query.driveRoles.findMany.mockResolvedValueOnce(roles);

      const result = await listDriveRoles('drive-1');
      expect(result).toEqual(roles);
    });
  });

  describe('getRoleById', () => {
    it('should return role when found', async () => {
      mockDb.query.driveRoles.findFirst.mockResolvedValueOnce({ id: 'r1', name: 'Editor' });
      expect(await getRoleById('drive-1', 'r1')).toEqual({ id: 'r1', name: 'Editor' });
    });

    it('should return null when not found', async () => {
      mockDb.query.driveRoles.findFirst.mockResolvedValueOnce(null);
      expect(await getRoleById('drive-1', 'r-x')).toBeNull();
    });
  });

  describe('createDriveRole', () => {
    it('should create role at next position', async () => {
      const newRole = { id: 'r3', name: 'New Role', position: 2 };
      const tx = makeTx([{ id: 'r1', position: 0 }, { id: 'r2', position: 1 }], [], [newRole]);
      mockDb.transaction.mockImplementation(async (fn: Function) => fn(tx));

      const result = await createDriveRole('drive-1', { name: 'New Role', permissions: {} });
      expect(result).toEqual(newRole);
    });

    it('should start at 0 when no existing roles', async () => {
      const tx = makeTx([], [], [{ id: 'r1', position: 0 }]);
      mockDb.transaction.mockImplementation(async (fn: Function) => fn(tx));

      const result = await createDriveRole('drive-1', { name: 'First', permissions: {} });
      expect(result.position).toBe(0);
    });

    it('should unset other defaults when isDefault', async () => {
      // isDefault takes the ordered drive-wide lock (see makeTx / updateDriveRole
      // tests below) before the unset-defaults write and the insert.
      const tx = makeTx([], [undefined], [{ id: 'r1', isDefault: true }]);
      mockDb.transaction.mockImplementation(async (fn: Function) => fn(tx));

      const result = await createDriveRole('drive-1', { name: 'Default', isDefault: true, permissions: {} });
      expect(result.isDefault).toBe(true);
      expect(tx.orderByMock).toHaveBeenCalledTimes(1);
    });

    it('should not take the drive-wide ordered lock when isDefault is not set', async () => {
      const tx = makeTx([{ id: 'r1', position: 0 }], [], [{ id: 'r2', position: 1 }]);
      mockDb.transaction.mockImplementation(async (fn: Function) => fn(tx));

      await createDriveRole('drive-1', { name: 'Non-default', permissions: {} });
      expect(tx.orderByMock).not.toHaveBeenCalled();
    });

    it('should throw when driveWidePermissions is malformed', async () => {
      await expect(
        createDriveRole('drive-1', { name: 'X', permissions: {}, driveWidePermissions: { invalid: true } as never })
      ).rejects.toThrow('Invalid driveWidePermissions structure');
      // Validation short-circuits before any transaction is opened.
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('should accept null driveWidePermissions', async () => {
      const tx = makeTx([], [], [{ id: 'r1', driveWidePermissions: null }]);
      mockDb.transaction.mockImplementation(async (fn: Function) => fn(tx));

      const result = await createDriveRole('drive-1', { name: 'X', permissions: {}, driveWidePermissions: null });
      expect(result.driveWidePermissions).toBeNull();
    });
  });

  describe('updateDriveRole', () => {
    it('should throw when role not found', async () => {
      const tx = makeTx([], []);
      mockDb.transaction.mockImplementation(async (fn: Function) => fn(tx));

      await expect(updateDriveRole('drive-1', 'r-x', { name: 'X' }))
        .rejects.toThrow('Role not found');
    });

    it('should lock the role row with FOR UPDATE', async () => {
      const tx = makeTx([{ id: 'r1', isDefault: false, permissions: {} }], [[{ id: 'r1', name: 'Updated' }]]);
      mockDb.transaction.mockImplementation(async (fn: Function) => fn(tx));

      await updateDriveRole('drive-1', 'r1', { name: 'Updated' });
      expect(tx.forMock).toHaveBeenCalledWith('update');
    });

    it('should update and return result', async () => {
      const tx = makeTx([{ id: 'r1', isDefault: false, permissions: {} }], [[{ id: 'r1', name: 'Updated' }]]);
      mockDb.transaction.mockImplementation(async (fn: Function) => fn(tx));

      const result = await updateDriveRole('drive-1', 'r1', { name: 'Updated' });
      expect(result.role.name).toBe('Updated');
      expect(result.wasDefault).toBe(false);
    });

    it('should unset other defaults when setting isDefault', async () => {
      const tx = makeTx(
        [{ id: 'r1', isDefault: false, permissions: {} }],
        [undefined, [{ id: 'r1', isDefault: true }]]
      );
      mockDb.transaction.mockImplementation(async (fn: Function) => fn(tx));

      const result = await updateDriveRole('drive-1', 'r1', { isDefault: true });
      expect(result.role.isDefault).toBe(true);
    });

    it('should lock all drive role rows in a consistent order when setting isDefault', async () => {
      // The drive-wide "unset other defaults" write touches every role row in
      // the drive; locking only the target row first would let two concurrent
      // default-switches deadlock on each other's targets. The isDefault path
      // must take an ordered drive-wide lock instead of a single-row lock.
      const tx = makeTx(
        [
          { id: 'r1', isDefault: true, permissions: {} },
          { id: 'r2', isDefault: false, permissions: {} },
        ],
        [undefined, [{ id: 'r2', isDefault: true }]]
      );
      mockDb.transaction.mockImplementation(async (fn: Function) => fn(tx));

      const result = await updateDriveRole('drive-1', 'r2', { isDefault: true });
      expect(result.role.isDefault).toBe(true);
      expect(result.wasDefault).toBe(false);
      expect(tx.orderByMock).toHaveBeenCalledTimes(1);
      expect(tx.forMock).toHaveBeenCalledWith('update');
    });

    it('should not take the drive-wide ordered lock when isDefault is not being set', async () => {
      const tx = makeTx([{ id: 'r1', isDefault: false, permissions: {} }], [[{ id: 'r1', name: 'Updated' }]]);
      mockDb.transaction.mockImplementation(async (fn: Function) => fn(tx));

      await updateDriveRole('drive-1', 'r1', { name: 'Updated' });
      expect(tx.orderByMock).not.toHaveBeenCalled();
      expect(tx.forMock).toHaveBeenCalledWith('update');
    });

    it('should throw when target role is missing from the drive-wide locked set on the isDefault path', async () => {
      const tx = makeTx([{ id: 'r-other', isDefault: true, permissions: {} }], []);
      mockDb.transaction.mockImplementation(async (fn: Function) => fn(tx));

      await expect(updateDriveRole('drive-1', 'r-x', { isDefault: true }))
        .rejects.toThrow('Role not found');
    });

    it('should throw when driveWidePermissions is malformed', async () => {
      await expect(
        updateDriveRole('drive-1', 'r1', { driveWidePermissions: { bad: 'field' } as never })
      ).rejects.toThrow('Invalid driveWidePermissions structure');
      // Validation short-circuits before any transaction is opened.
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('should throw when both permissions and permissionsPatch are given', async () => {
      await expect(
        updateDriveRole('drive-1', 'r1', { permissions: {}, permissionsPatch: {} })
      ).rejects.toThrow('Cannot specify both permissions and permissionsPatch');
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('should merge permissionsPatch against the row read inside the transaction, not a stale pre-transaction read', async () => {
      // Regression test for the read-modify-write race (#1425): the existing
      // permissions used for the merge must come from the locked, in-transaction
      // read, so a concurrent writer that changed the row between an earlier
      // unlocked read and this call is still reflected.
      const lockedRow = {
        id: 'r1',
        isDefault: false,
        permissions: { 'page-a': { canView: true, canEdit: false, canShare: false } },
      };
      const tx = makeTx([lockedRow], [[{ id: 'r1', permissions: {
        'page-a': { canView: true, canEdit: false, canShare: false },
        'page-b': { canView: true, canEdit: true, canShare: false },
      } }]]);
      mockDb.transaction.mockImplementation(async (fn: Function) => fn(tx));

      await updateDriveRole('drive-1', 'r1', {
        permissionsPatch: { 'page-b': { canView: true, canEdit: true, canShare: false } },
      });

      const setCall = (tx.update.mock.results[0]?.value as { set: MockFn }).set;
      expect(setCall).toHaveBeenCalledWith(
        expect.objectContaining({
          permissions: {
            'page-a': { canView: true, canEdit: false, canShare: false },
            'page-b': { canView: true, canEdit: true, canShare: false },
          },
        })
      );
    });

    it('should prune a page via a null permissionsPatch entry', async () => {
      const lockedRow = {
        id: 'r1',
        isDefault: false,
        permissions: { 'page-a': { canView: true, canEdit: false, canShare: false } },
      };
      const tx = makeTx([lockedRow], [[{ id: 'r1', permissions: {} }]]);
      mockDb.transaction.mockImplementation(async (fn: Function) => fn(tx));

      await updateDriveRole('drive-1', 'r1', { permissionsPatch: { 'page-a': null } });

      const setCall = (tx.update.mock.results[0]?.value as { set: MockFn }).set;
      expect(setCall).toHaveBeenCalledWith(expect.objectContaining({ permissions: {} }));
    });
  });

  describe('deleteDriveRole', () => {
    it('should throw when role not found', async () => {
      mockDb.query.driveRoles.findFirst.mockResolvedValueOnce(null);
      await expect(deleteDriveRole('drive-1', 'r-x')).rejects.toThrow('Role not found');
    });

    it('should delete existing role without throwing', async () => {
      mockDb.query.driveRoles.findFirst.mockResolvedValueOnce({ id: 'r1' });
      mockDb.delete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });

      // void function — verifying it resolves without error is the contract
      await expect(deleteDriveRole('drive-1', 'r1')).resolves.toBeUndefined();
    });
  });

  describe('reorderDriveRoles', () => {
    it('should throw for invalid role IDs', async () => {
      const tx = makeTx([{ id: 'r1' }, { id: 'r2' }]);
      mockDb.transaction.mockImplementation(async (fn: Function) => fn(tx));

      await expect(reorderDriveRoles('drive-1', ['r1', 'r3'])).rejects.toThrow('Invalid role IDs');
      // Invalid-id rejection short-circuits before the batched write is ever attempted.
      expect(tx.execute).not.toHaveBeenCalled();
    });

    it('should write positions as a single batched statement instead of N sequential updates', async () => {
      const tx = makeTx([{ id: 'r1' }, { id: 'r2' }]);
      mockDb.transaction.mockImplementation(async (fn: Function) => fn(tx));

      await expect(reorderDriveRoles('drive-1', ['r2', 'r1'])).resolves.toBeUndefined();
      expect(tx.execute).toHaveBeenCalledTimes(1);
      // No more per-row tx.update(...).set(...).where(...) calls for the write.
      expect(tx.update).not.toHaveBeenCalled();
    });

    it('should take the ordered drive-wide lock (lockDriveRolesInOrder) before lockedBatchReorder batches the write', async () => {
      // Locking the drive's role rows in id order before writing positions
      // avoids a deadlock against a concurrent updateDriveRole isDefault
      // switch, which locks in the same order (see lockDriveRolesInOrder).
      // lockedBatchReorder then re-locks (harmlessly, same tx) only the
      // targeted rows before its own batched write — hence two orderBy/for
      // ('update') pairs instead of one.
      const tx = makeTx([{ id: 'r1' }, { id: 'r2' }]);
      mockDb.transaction.mockImplementation(async (fn: Function) => fn(tx));

      await reorderDriveRoles('drive-1', ['r2', 'r1']);

      expect(tx.orderByMock).toHaveBeenCalledTimes(2);
      expect(tx.forMock).toHaveBeenCalledWith('update');
      const firstSelectOrder = tx.select.mock.invocationCallOrder[0];
      const executeOrder = tx.execute.mock.invocationCallOrder[0];
      expect(firstSelectOrder).toBeLessThan(executeOrder);
    });

    it('should no-op on an empty roleIds array without touching the batched write', async () => {
      const tx = makeTx([{ id: 'r1' }, { id: 'r2' }]);
      mockDb.transaction.mockImplementation(async (fn: Function) => fn(tx));

      await expect(reorderDriveRoles('drive-1', [])).resolves.toBeUndefined();
      // Still takes the drive-wide lock (validation), but skips the batched write entirely.
      expect(tx.orderByMock).toHaveBeenCalledTimes(1);
      expect(tx.execute).not.toHaveBeenCalled();
    });
  });

  describe('validateRolePermissions', () => {
    it('should return false for null', () => expect(validateRolePermissions(null)).toBe(false));
    it('should return false for array', () => expect(validateRolePermissions([])).toBe(false));
    it('should return false for string', () => expect(validateRolePermissions('str')).toBe(false));
    it('should return false for null entry', () => expect(validateRolePermissions({ p: null })).toBe(false));
    it('should return false for invalid booleans', () =>
      expect(validateRolePermissions({ p: { canView: 'yes', canEdit: false, canShare: false } })).toBe(false));
    it('should return false for missing keys', () =>
      expect(validateRolePermissions({ p: { canView: true } })).toBe(false));
    it('should return true for valid permissions', () =>
      expect(validateRolePermissions({ p: { canView: true, canEdit: false, canShare: false } })).toBe(true));
    it('should return true for empty object', () => expect(validateRolePermissions({})).toBe(true));
  });

  describe('validateDriveWidePermissions', () => {
    it('should return true for null', () => expect(validateDriveWidePermissions(null)).toBe(true));
    it('should return true for undefined', () => expect(validateDriveWidePermissions(undefined)).toBe(true));
    it('should return true for valid object', () =>
      expect(validateDriveWidePermissions({ canView: true, canEdit: false, canShare: false })).toBe(true));
    it('should return false for array', () => expect(validateDriveWidePermissions([])).toBe(false));
    it('should return false for string', () => expect(validateDriveWidePermissions('yes')).toBe(false));
    it('should return false for missing key', () =>
      expect(validateDriveWidePermissions({ canView: true, canEdit: false })).toBe(false));
    it('should return false for non-boolean value', () =>
      expect(validateDriveWidePermissions({ canView: 1, canEdit: false, canShare: false })).toBe(false));
    it('should return false for object with extra keys', () =>
      expect(validateDriveWidePermissions({ canView: true, canEdit: false, canShare: false, canDelete: true })).toBe(false));
  });

  describe('mergeRolePermissionsPatch', () => {
    it('should add a new page entry', () => {
      const existing = { 'page-a': { canView: true, canEdit: false, canShare: false } };
      const merged = mergeRolePermissionsPatch(existing, {
        'page-b': { canView: true, canEdit: true, canShare: false },
      });
      expect(merged).toEqual({
        'page-a': { canView: true, canEdit: false, canShare: false },
        'page-b': { canView: true, canEdit: true, canShare: false },
      });
    });

    it('should overwrite an existing page entry', () => {
      const existing = { 'page-a': { canView: true, canEdit: false, canShare: false } };
      const merged = mergeRolePermissionsPatch(existing, {
        'page-a': { canView: true, canEdit: true, canShare: true },
      });
      expect(merged['page-a']).toEqual({ canView: true, canEdit: true, canShare: true });
    });

    it('should prune a page entry when patched with null', () => {
      const existing = {
        'page-a': { canView: true, canEdit: false, canShare: false },
        'page-b': { canView: true, canEdit: true, canShare: false },
      };
      const merged = mergeRolePermissionsPatch(existing, { 'page-a': null });
      expect(merged).toEqual({ 'page-b': { canView: true, canEdit: true, canShare: false } });
    });

    it('should leave pages not named in the patch untouched', () => {
      const existing = {
        'page-a': { canView: true, canEdit: false, canShare: false },
        'page-b': { canView: true, canEdit: true, canShare: false },
      };
      const merged = mergeRolePermissionsPatch(existing, {
        'page-c': { canView: true, canEdit: false, canShare: false },
      });
      expect(merged['page-a']).toEqual(existing['page-a']);
      expect(merged['page-b']).toEqual(existing['page-b']);
    });

    it('should not mutate the existing map', () => {
      const existing = { 'page-a': { canView: true, canEdit: false, canShare: false } };
      mergeRolePermissionsPatch(existing, { 'page-b': { canView: true, canEdit: true, canShare: false } });
      expect(existing).toEqual({ 'page-a': { canView: true, canEdit: false, canShare: false } });
    });
  });
});
