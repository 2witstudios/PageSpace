import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateUserRole, validateAdminAccess } from '../admin-role';

// Mock @pagespace/db at the module boundary - never connect to real DB
vi.mock('@pagespace/db', () => {
  const mockDb = {
    update: vi.fn(),
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
  };

  // Chain builder for update().set().where().returning()
  const mockReturning = vi.fn();
  const mockWhere = vi.fn(() => ({ returning: mockReturning }));
  const mockSet = vi.fn(() => ({ where: mockWhere }));
  mockDb.update.mockReturnValue({ set: mockSet });

  return {
    db: mockDb,
    users: { id: 'users.id', role: 'users.role', adminRoleVersion: 'users.adminRoleVersion' },
    eq: vi.fn((col, val) => ({ col, val })),
    sql: Object.assign(vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ raw: strings.join(''), values })), {
      placeholder: vi.fn(),
    }),
  };
});

import { db, eq } from '@pagespace/db';

const mockDb = db as unknown as {
  update: ReturnType<typeof vi.fn>;
  query: { users: { findFirst: ReturnType<typeof vi.fn> } };
};

describe('admin-role', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Re-wire the chainable mock after clearAllMocks
    const mockReturning = vi.fn();
    const mockWhere = vi.fn(() => ({ returning: mockReturning }));
    const mockSet = vi.fn(() => ({ where: mockWhere }));
    mockDb.update.mockReturnValue({ set: mockSet });
  });

  // Helper to get the .returning mock from the chain
  function getReturningMock() {
    const setMock = mockDb.update.mock.results[0]?.value?.set;
    const whereMock = setMock?.mock?.results[0]?.value?.where;
    return whereMock?.mock?.results[0]?.value?.returning;
  }

  describe('updateUserRole', () => {
    it('should return updated user when role change succeeds', async () => {
      const updatedUser = { id: 'user-123', role: 'admin' as const, adminRoleVersion: 1 };

      // Pre-wire the returning mock before calling updateUserRole
      const mockReturning = vi.fn().mockResolvedValue([updatedUser]);
      const mockWhere = vi.fn(() => ({ returning: mockReturning }));
      const mockSet = vi.fn(() => ({ where: mockWhere }));
      mockDb.update.mockReturnValue({ set: mockSet });

      const result = await updateUserRole('user-123', 'admin');

      expect(result).toEqual(updatedUser);
    });

    it('should return null when user is not found', async () => {
      const mockReturning = vi.fn().mockResolvedValue([]);
      const mockWhere = vi.fn(() => ({ returning: mockReturning }));
      const mockSet = vi.fn(() => ({ where: mockWhere }));
      mockDb.update.mockReturnValue({ set: mockSet });

      const result = await updateUserRole('nonexistent-id', 'admin');

      expect(result).toBeNull();
    });

    it('should call db.update with users table', async () => {
      const mockReturning = vi.fn().mockResolvedValue([{ id: 'user-123', role: 'user', adminRoleVersion: 2 }]);
      const mockWhere = vi.fn(() => ({ returning: mockReturning }));
      const mockSet = vi.fn(() => ({ where: mockWhere }));
      mockDb.update.mockReturnValue({ set: mockSet });

      await updateUserRole('user-123', 'user');

      expect(mockDb.update).toHaveBeenCalledOnce();
    });

    it('should pass userId to where clause using eq', async () => {
      const mockReturning = vi.fn().mockResolvedValue([{ id: 'user-abc', role: 'admin', adminRoleVersion: 1 }]);
      const mockWhere = vi.fn(() => ({ returning: mockReturning }));
      const mockSet = vi.fn(() => ({ where: mockWhere }));
      mockDb.update.mockReturnValue({ set: mockSet });

      await updateUserRole('user-abc', 'admin');

      expect(eq).toHaveBeenCalledWith(expect.anything(), 'user-abc');
    });

    it('should return first element from results array', async () => {
      const first = { id: 'user-1', role: 'admin' as const, adminRoleVersion: 3 };
      const mockReturning = vi.fn().mockResolvedValue([first, { id: 'user-2', role: 'user' as const, adminRoleVersion: 0 }]);
      const mockWhere = vi.fn(() => ({ returning: mockReturning }));
      const mockSet = vi.fn(() => ({ where: mockWhere }));
      mockDb.update.mockReturnValue({ set: mockSet });

      const result = await updateUserRole('user-1', 'admin');

      expect(result).toEqual(first);
    });

    it('should propagate errors from the database', async () => {
      const dbError = new Error('Database connection failed');
      const mockReturning = vi.fn().mockRejectedValue(dbError);
      const mockWhere = vi.fn(() => ({ returning: mockReturning }));
      const mockSet = vi.fn(() => ({ where: mockWhere }));
      mockDb.update.mockReturnValue({ set: mockSet });

      await expect(updateUserRole('user-123', 'admin')).rejects.toThrow('Database connection failed');
    });
  });

  describe('validateAdminAccess', () => {
    it('should return isValid true when user is admin with matching version', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        role: 'admin',
        adminRoleVersion: 5,
      });

      const result = await validateAdminAccess('user-123', 5);

      expect(result.isValid).toBe(true);
      expect(result.actualAdminRoleVersion).toBe(5);
      expect(result.reason).toBeUndefined();
    });

    it('should return user_not_found when user does not exist', async () => {
      mockDb.query.users.findFirst.mockResolvedValue(null);

      const result = await validateAdminAccess('nonexistent-id', 0);

      expect(result.isValid).toBe(false);
      expect(result.reason).toBe('user_not_found');
    });

    it('should return not_admin when user role is user', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        role: 'user',
        adminRoleVersion: 0,
      });

      const result = await validateAdminAccess('user-123', 0);

      expect(result.isValid).toBe(false);
      expect(result.reason).toBe('not_admin');
      expect(result.currentRole).toBe('user');
      expect(result.actualAdminRoleVersion).toBe(0);
    });

    it('should return version_mismatch when adminRoleVersion does not match claimed version', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        role: 'admin',
        adminRoleVersion: 3,
      });

      const result = await validateAdminAccess('user-123', 2);

      expect(result.isValid).toBe(false);
      expect(result.reason).toBe('version_mismatch');
      expect(result.currentRole).toBe('admin');
      expect(result.actualAdminRoleVersion).toBe(3);
    });

    it('should return version_mismatch when claimed version is higher than actual', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        role: 'admin',
        adminRoleVersion: 1,
      });

      const result = await validateAdminAccess('user-123', 5);

      expect(result.isValid).toBe(false);
      expect(result.reason).toBe('version_mismatch');
      expect(result.actualAdminRoleVersion).toBe(1);
    });

    it('should query the database with the given userId', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        role: 'admin',
        adminRoleVersion: 0,
      });

      await validateAdminAccess('specific-user-id', 0);

      expect(mockDb.query.users.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.anything(),
          columns: { role: true, adminRoleVersion: true },
        })
      );
      expect(eq).toHaveBeenCalledWith(expect.anything(), 'specific-user-id');
    });

    it('should return not_admin with role details when non-admin claims version 0', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        role: 'user',
        adminRoleVersion: 7,
      });

      const result = await validateAdminAccess('user-123', 0);

      expect(result.isValid).toBe(false);
      expect(result.reason).toBe('not_admin');
      expect(result.currentRole).toBe('user');
      expect(result.actualAdminRoleVersion).toBe(7);
    });

    it('should propagate database errors', async () => {
      mockDb.query.users.findFirst.mockRejectedValue(new Error('Query failed'));

      await expect(validateAdminAccess('user-123', 0)).rejects.toThrow('Query failed');
    });

    it('should handle version 0 as a valid matching version for admin', async () => {
      mockDb.query.users.findFirst.mockResolvedValue({
        role: 'admin',
        adminRoleVersion: 0,
      });

      const result = await validateAdminAccess('user-123', 0);

      expect(result.isValid).toBe(true);
      expect(result.actualAdminRoleVersion).toBe(0);
    });
  });
});
