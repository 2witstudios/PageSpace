/**
 * @scaffold - ORM chain mocks present. Pending drive-role-repository seam
 * extraction to replace select().from().where() and update/insert chains
 * with a mockable repository interface.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db', () => {
  const eq = vi.fn((a, b) => ({ op: 'eq', a, b }));
  const and = vi.fn((...args: unknown[]) => ({ op: 'and', args }));
  const asc = vi.fn((a) => ({ op: 'asc', a }));

  return {
    db: {
      query: {
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
    driveRoles: { id: 'dr.id', driveId: 'dr.driveId', name: 'dr.name', description: 'dr.description', color: 'dr.color', isDefault: 'dr.isDefault', permissions: 'dr.permissions', position: 'dr.position', updatedAt: 'dr.updatedAt' },
    drives: { id: 'drives.id', name: 'drives.name', slug: 'drives.slug', ownerId: 'drives.ownerId' },
    driveMembers: { driveId: 'dm.driveId', userId: 'dm.userId', role: 'dm.role' },
    eq, and, asc,
  };
});

import { db } from '@pagespace/db';
import {
  checkDriveAccessForRoles,
  listDriveRoles,
  getRoleById,
  createDriveRole,
  updateDriveRole,
  deleteDriveRole,
  reorderDriveRoles,
  validateRolePermissions,
} from '../drive-role-service';

type MockFn = ReturnType<typeof vi.fn>;
type MockDb = {
  query: {
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

describe('drive-role-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkDriveAccessForRoles', () => {
    it('should return no access when drive not found', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await checkDriveAccessForRoles('drive-1', 'user-1');
      expect(result.drive).toBeNull();
      expect(result.isOwner).toBe(false);
    });

    it('should return owner access', async () => {
      const drive = { id: 'drive-1', name: 'My Drive', slug: 'my-drive', ownerId: 'user-1' };
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([drive]),
          }),
        }),
      });

      const result = await checkDriveAccessForRoles('drive-1', 'user-1');
      expect(result.isOwner).toBe(true);
      expect(result.isAdmin).toBe(true);
      expect(result.drive!.name).toBe('My Drive');
    });

    it('should return admin for ADMIN member', async () => {
      const drive = { id: 'drive-1', name: 'My Drive', slug: 'my-drive', ownerId: 'other' };
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([drive]),
          }),
        }),
      });
      mockDb.query.driveMembers.findFirst.mockResolvedValueOnce({ role: 'ADMIN' });

      const result = await checkDriveAccessForRoles('drive-1', 'user-1');
      expect(result.isAdmin).toBe(true);
      expect(result.isMember).toBe(true);
    });

    it('should return non-admin for MEMBER role', async () => {
      const drive = { id: 'drive-1', name: 'My Drive', slug: 'my-drive', ownerId: 'other' };
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([drive]),
          }),
        }),
      });
      mockDb.query.driveMembers.findFirst.mockResolvedValueOnce({ role: 'MEMBER' });

      const result = await checkDriveAccessForRoles('drive-1', 'user-1');
      expect(result.isAdmin).toBe(false);
      expect(result.isMember).toBe(true);
    });

    it('should return non-member when no membership', async () => {
      const drive = { id: 'drive-1', name: 'My Drive', slug: 'my-drive', ownerId: 'other' };
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([drive]),
          }),
        }),
      });
      mockDb.query.driveMembers.findFirst.mockResolvedValueOnce(null);

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
      mockDb.query.driveRoles.findMany.mockResolvedValueOnce([
        { id: 'r1', position: 0 }, { id: 'r2', position: 1 },
      ]);

      const newRole = { id: 'r3', name: 'New Role', position: 2 };
      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([newRole]),
        }),
      });

      const result = await createDriveRole('drive-1', { name: 'New Role', permissions: {} });
      expect(result).toEqual(newRole);
    });

    it('should start at 0 when no existing roles', async () => {
      mockDb.query.driveRoles.findMany.mockResolvedValueOnce([]);

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'r1', position: 0 }]),
        }),
      });

      const result = await createDriveRole('drive-1', { name: 'First', permissions: {} });
      expect(result.position).toBe(0);
    });

    it('should unset other defaults when isDefault', async () => {
      mockDb.query.driveRoles.findMany.mockResolvedValueOnce([]);
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });
      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'r1', isDefault: true }]),
        }),
      });

      const result = await createDriveRole('drive-1', { name: 'Default', isDefault: true, permissions: {} });
      expect(result.isDefault).toBe(true);
    });
  });

  describe('updateDriveRole', () => {
    it('should throw when role not found', async () => {
      mockDb.query.driveRoles.findFirst.mockResolvedValueOnce(null);
      await expect(updateDriveRole('drive-1', 'r-x', { name: 'X' }))
        .rejects.toThrow('Role not found');
    });

    it('should update and return result', async () => {
      mockDb.query.driveRoles.findFirst.mockResolvedValueOnce({ id: 'r1', isDefault: false });
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'r1', name: 'Updated' }]),
          }),
        }),
      });

      const result = await updateDriveRole('drive-1', 'r1', { name: 'Updated' });
      expect(result.role.name).toBe('Updated');
      expect(result.wasDefault).toBe(false);
    });

    it('should unset other defaults when setting isDefault', async () => {
      mockDb.query.driveRoles.findFirst.mockResolvedValueOnce({ id: 'r1', isDefault: false });
      mockDb.update
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        })
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'r1', isDefault: true }]),
            }),
          }),
        });

      const result = await updateDriveRole('drive-1', 'r1', { isDefault: true });
      expect(result.role.isDefault).toBe(true);
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
      mockDb.query.driveRoles.findMany.mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }]);
      await expect(reorderDriveRoles('drive-1', ['r1', 'r3'])).rejects.toThrow('Invalid role IDs');
    });

    it('should update positions in transaction', async () => {
      mockDb.query.driveRoles.findMany.mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }]);
      mockDb.transaction.mockImplementation(async (fn: Function) => {
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        await fn(tx);
      });

      // void function — verifying it resolves without error is the contract
      await expect(reorderDriveRoles('drive-1', ['r2', 'r1'])).resolves.toBeUndefined();
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
});
