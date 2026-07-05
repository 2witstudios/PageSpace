import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findFirst: vi.fn() },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ['eq', a, b]),
  and: vi.fn((...c) => ['and', ...c]),
}));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'users.id' } }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'pages.id' } }));
vi.mock('@pagespace/db/schema/members', () => ({
  pagePermissions: { pageId: 'pagePermissions.pageId', userId: 'pagePermissions.userId' },
  driveMembers: { driveId: 'driveMembers.driveId', userId: 'driveMembers.userId', role: 'driveMembers.role' },
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getUserAccessLevel: vi.fn(async () => ({ canShare: true })),
}));
vi.mock('@pagespace/lib/services/drive-role-service', () => ({
  listDriveRoles: vi.fn(),
  getRoleById: vi.fn(),
  updateDriveRole: vi.fn(),
}));

import { db } from '@pagespace/db/db';
import { getRoleById, updateDriveRole } from '@pagespace/lib/services/drive-role-service';
import { rolePermissionService } from '../permission-management-service';

type MockFn = ReturnType<typeof vi.fn>;
const mockPagesFindFirst = (db as unknown as { query: { pages: { findFirst: MockFn } } }).query.pages.findFirst;
const mockGetRoleById = getRoleById as unknown as MockFn;
const mockUpdateDriveRole = updateDriveRole as unknown as MockFn;

describe('rolePermissionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPagesFindFirst.mockResolvedValue({ driveId: 'drive-1' });
    mockGetRoleById.mockResolvedValue({
      id: 'role-1',
      permissions: { 'page-existing': { canView: true, canEdit: false, canShare: false } },
    });
  });

  describe('setRolePagePermission', () => {
    it('should send a permissionsPatch for just the target page, not a full permissions replace', async () => {
      const result = await rolePermissionService.setRolePagePermission(
        'user-1',
        'page-1',
        'role-1',
        { canView: true, canEdit: true, canShare: false },
      );

      expect(result).toEqual({ success: true });
      expect(mockUpdateDriveRole).toHaveBeenCalledWith('drive-1', 'role-1', {
        permissionsPatch: {
          'page-1': { canView: true, canEdit: true, canShare: false },
        },
      });
      // Must NOT compute a full-map replace from the earlier `getRoleById` read —
      // that's the read-modify-write race this call site used to have (#1425).
      const call = mockUpdateDriveRole.mock.calls[0][2];
      expect(call.permissions).toBeUndefined();
    });

    it('should reject canEdit/canShare without canView', async () => {
      const result = await rolePermissionService.setRolePagePermission(
        'user-1',
        'page-1',
        'role-1',
        { canView: false, canEdit: true, canShare: false },
      );
      expect(result).toEqual({ success: false, error: 'canView must be true when canEdit or canShare is set', status: 400 });
      expect(mockUpdateDriveRole).not.toHaveBeenCalled();
    });

    it('should return 404 when role not found', async () => {
      mockGetRoleById.mockResolvedValueOnce(null);
      const result = await rolePermissionService.setRolePagePermission(
        'user-1',
        'page-1',
        'role-1',
        { canView: true, canEdit: false, canShare: false },
      );
      expect(result).toEqual({ success: false, error: 'Role not found', status: 404 });
      expect(mockUpdateDriveRole).not.toHaveBeenCalled();
    });

    it('should return 404 when page not found', async () => {
      mockPagesFindFirst.mockResolvedValueOnce(null);
      const result = await rolePermissionService.setRolePagePermission(
        'user-1',
        'page-1',
        'role-1',
        { canView: true, canEdit: false, canShare: false },
      );
      expect(result).toEqual({ success: false, error: 'Page not found', status: 404 });
      expect(mockUpdateDriveRole).not.toHaveBeenCalled();
    });
  });

  describe('removeRolePagePermission', () => {
    it('should send a null permissionsPatch entry for just the target page, not a full permissions replace', async () => {
      const result = await rolePermissionService.removeRolePagePermission('user-1', 'page-existing', 'role-1');

      expect(result).toEqual({ success: true });
      expect(mockUpdateDriveRole).toHaveBeenCalledWith('drive-1', 'role-1', {
        permissionsPatch: { 'page-existing': null },
      });
      const call = mockUpdateDriveRole.mock.calls[0][2];
      expect(call.permissions).toBeUndefined();
    });

    it('should return 404 when role not found', async () => {
      mockGetRoleById.mockResolvedValueOnce(null);
      const result = await rolePermissionService.removeRolePagePermission('user-1', 'page-1', 'role-1');
      expect(result).toEqual({ success: false, error: 'Role not found', status: 404 });
      expect(mockUpdateDriveRole).not.toHaveBeenCalled();
    });
  });
});
