import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findFirst: vi.fn() },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId' },
}));

vi.mock('@pagespace/lib/services/drive-role-service', () => ({
  checkDriveAccessForRoles: vi.fn(),
  listDriveRoles: vi.fn(),
  getRoleById: vi.fn(),
  createDriveRole: vi.fn(),
  updateDriveRole: vi.fn(),
  deleteDriveRole: vi.fn(),
}));

vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveRecipientUserIds: vi.fn().mockResolvedValue(['owner1', 'user1']),
}));

vi.mock('../actor-permissions', () => ({
  driveDeniedByAppToken: vi.fn(),
}));

vi.mock('../task-helpers', () => ({
  getAiContextWithActor: vi.fn().mockResolvedValue({ source: 'ai' }),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  logDriveActivity: vi.fn(),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastDriveEvent: vi.fn(),
  createDriveEventPayload: vi.fn(),
}));

import { roleManagementTools } from '../role-management-tools';
import {
  checkDriveAccessForRoles,
  listDriveRoles,
  getRoleById,
  createDriveRole,
  updateDriveRole,
  deleteDriveRole,
} from '@pagespace/lib/services/drive-role-service';
import { driveDeniedByAppToken } from '../actor-permissions';
import type { ToolExecutionContext } from '../../core/types';

const mockCheckAccess = vi.mocked(checkDriveAccessForRoles);
const mockListRoles = vi.mocked(listDriveRoles);
const mockGetRole = vi.mocked(getRoleById);
const mockCreateRole = vi.mocked(createDriveRole);
const mockUpdateRole = vi.mocked(updateDriveRole);
const mockDeleteRole = vi.mocked(deleteDriveRole);
const mockDenied = vi.mocked(driveDeniedByAppToken);

const makeContext = (userId?: string) => ({
  toolCallId: '1',
  messages: [],
  experimental_context: (userId ? { userId } : {}) as ToolExecutionContext,
});

const drive = { id: 'drive1', name: 'Test Drive', slug: 'test-drive', ownerId: 'owner1' };

const memberAccess = { isOwner: false, isAdmin: false, isMember: true, drive };
const adminAccess = { isOwner: false, isAdmin: true, isMember: true, drive };

const makeRole = (overrides: Record<string, unknown> = {}) => ({
  id: 'role1',
  driveId: 'drive1',
  name: 'Editors',
  description: null,
  color: null,
  isDefault: false,
  permissions: {},
  driveWidePermissions: null,
  position: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('role-management-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDenied.mockResolvedValue(false);
  });

  describe('list_drive_roles', () => {
    it('throws when userId is missing', async () => {
      await expect(
        roleManagementTools.list_drive_roles.execute!({ driveId: 'drive1' }, makeContext())
      ).rejects.toThrow('User authentication required');
    });

    it('returns error when drive not found', async () => {
      mockCheckAccess.mockResolvedValueOnce({ isOwner: false, isAdmin: false, isMember: false, drive: null });

      const result = await roleManagementTools.list_drive_roles.execute!(
        { driveId: 'missing' },
        makeContext('user1')
      );

      expect(result).toMatchObject({ success: false, error: 'Drive not found' });
    });

    it('returns error when user is not a drive member', async () => {
      mockCheckAccess.mockResolvedValueOnce({ isOwner: false, isAdmin: false, isMember: false, drive });

      const result = await roleManagementTools.list_drive_roles.execute!(
        { driveId: 'drive1' },
        makeContext('outsider')
      ) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('member');
    });

    it('returns roles for a member when drive has 3 roles', async () => {
      mockCheckAccess.mockResolvedValueOnce(memberAccess);
      mockListRoles.mockResolvedValueOnce([
        makeRole({ id: 'r1', name: 'A' }),
        makeRole({ id: 'r2', name: 'B' }),
        makeRole({ id: 'r3', name: 'C' }),
      ]);

      const result = await roleManagementTools.list_drive_roles.execute!(
        { driveId: 'drive1' },
        makeContext('user1')
      ) as { success: boolean; roles: unknown[]; summary: string };

      expect(result.success).toBe(true);
      expect(result.roles).toHaveLength(3);
      expect(result.summary).toContain('3');
    });

    it('returns empty list when drive has 0 roles', async () => {
      mockCheckAccess.mockResolvedValueOnce(memberAccess);
      mockListRoles.mockResolvedValueOnce([]);

      const result = await roleManagementTools.list_drive_roles.execute!(
        { driveId: 'drive1' },
        makeContext('user1')
      ) as { success: boolean; roles: unknown[]; summary: string };

      expect(result.success).toBe(true);
      expect(result.roles).toEqual([]);
      expect(result.summary).toContain('0');
    });
  });

  describe('get_drive_role', () => {
    it('returns the full role for a valid member and roleId', async () => {
      mockCheckAccess.mockResolvedValueOnce(memberAccess);
      mockGetRole.mockResolvedValueOnce(
        makeRole({
          permissions: { page1: { canView: true, canEdit: false, canShare: false } },
          driveWidePermissions: { canView: true, canEdit: false, canShare: false },
        })
      );

      const result = await roleManagementTools.get_drive_role.execute!(
        { driveId: 'drive1', roleId: 'role1' },
        makeContext('user1')
      ) as { success: boolean; role: Record<string, unknown> };

      expect(result.success).toBe(true);
      expect(result.role).toMatchObject({
        id: 'role1',
        name: 'Editors',
        permissions: { page1: { canView: true, canEdit: false, canShare: false } },
        driveWidePermissions: { canView: true, canEdit: false, canShare: false },
      });
    });

    it('returns error when roleId is not found in this drive', async () => {
      mockCheckAccess.mockResolvedValueOnce(memberAccess);
      mockGetRole.mockResolvedValueOnce(null);

      const result = await roleManagementTools.get_drive_role.execute!(
        { driveId: 'drive1', roleId: 'nope' },
        makeContext('user1')
      ) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('create_drive_role', () => {
    it('rejects a plain member (not admin)', async () => {
      mockCheckAccess.mockResolvedValueOnce(memberAccess);

      const result = await roleManagementTools.create_drive_role.execute!(
        { driveId: 'drive1', name: 'Editors' },
        makeContext('user1')
      ) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('admin');
    });

    it('creates a role for an admin with a valid name', async () => {
      mockCheckAccess.mockResolvedValueOnce(adminAccess);
      mockCreateRole.mockResolvedValueOnce(makeRole({ id: 'newrole', name: 'Editors' }));

      const result = await roleManagementTools.create_drive_role.execute!(
        { driveId: 'drive1', name: 'Editors' },
        makeContext('admin1')
      ) as { success: boolean; role: Record<string, unknown> };

      expect(result.success).toBe(true);
      expect(result.role).toMatchObject({ id: 'newrole', name: 'Editors' });
    });

    it('returns error when the name already exists in the drive', async () => {
      mockCheckAccess.mockResolvedValueOnce(adminAccess);
      mockCreateRole.mockRejectedValueOnce(new Error('A role named "Editors" already exists'));

      const result = await roleManagementTools.create_drive_role.execute!(
        { driveId: 'drive1', name: 'Editors' },
        makeContext('admin1')
      ) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('passes provided driveWidePermissions through to the created role', async () => {
      const dwp = { canView: true, canEdit: true, canShare: false };
      mockCheckAccess.mockResolvedValueOnce(adminAccess);
      mockCreateRole.mockImplementationOnce(async (_driveId, input) =>
        makeRole({ id: 'r9', name: input.name, driveWidePermissions: input.driveWidePermissions ?? null })
      );

      const result = await roleManagementTools.create_drive_role.execute!(
        { driveId: 'drive1', name: 'Viewers', driveWidePermissions: dwp },
        makeContext('admin1')
      ) as { success: boolean; role: { driveWidePermissions: unknown } };

      expect(result.success).toBe(true);
      expect(result.role.driveWidePermissions).toEqual(dwp);
    });

    it('defaults driveWidePermissions to null when omitted', async () => {
      mockCheckAccess.mockResolvedValueOnce(adminAccess);
      mockCreateRole.mockImplementationOnce(async (_driveId, input) =>
        makeRole({ id: 'r10', name: input.name, driveWidePermissions: input.driveWidePermissions ?? null })
      );

      const result = await roleManagementTools.create_drive_role.execute!(
        { driveId: 'drive1', name: 'Plain' },
        makeContext('admin1')
      ) as { success: boolean; role: { driveWidePermissions: unknown } };

      expect(result.success).toBe(true);
      expect(result.role.driveWidePermissions).toBeNull();
    });
  });

  describe('update_drive_role', () => {
    it('rejects a plain member', async () => {
      mockCheckAccess.mockResolvedValueOnce(memberAccess);

      const result = await roleManagementTools.update_drive_role.execute!(
        { driveId: 'drive1', roleId: 'role1', name: 'Renamed' },
        makeContext('user1')
      ) as { success: boolean };

      expect(result.success).toBe(false);
    });

    it('updates a role for an admin with a valid roleId', async () => {
      mockCheckAccess.mockResolvedValueOnce(adminAccess);
      mockUpdateRole.mockResolvedValueOnce({
        role: makeRole({ name: 'Renamed' }),
        wasDefault: false,
      });

      const result = await roleManagementTools.update_drive_role.execute!(
        { driveId: 'drive1', roleId: 'role1', name: 'Renamed' },
        makeContext('admin1')
      ) as { success: boolean; role: Record<string, unknown> };

      expect(result.success).toBe(true);
      expect(result.role).toMatchObject({ name: 'Renamed' });
    });

    it('returns error when roleId is not in this drive', async () => {
      mockCheckAccess.mockResolvedValueOnce(adminAccess);
      mockUpdateRole.mockRejectedValueOnce(new Error('Role not found'));

      const result = await roleManagementTools.update_drive_role.execute!(
        { driveId: 'drive1', roleId: 'ghost', name: 'X' },
        makeContext('admin1')
      ) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('delete_drive_role', () => {
    it('rejects a plain member', async () => {
      mockCheckAccess.mockResolvedValueOnce(memberAccess);

      const result = await roleManagementTools.delete_drive_role.execute!(
        { driveId: 'drive1', roleId: 'role1' },
        makeContext('user1')
      ) as { success: boolean };

      expect(result.success).toBe(false);
    });

    it('deletes a role for an admin', async () => {
      mockCheckAccess.mockResolvedValueOnce(adminAccess);
      mockGetRole.mockResolvedValueOnce(makeRole());
      mockDeleteRole.mockResolvedValueOnce(undefined);

      const result = await roleManagementTools.delete_drive_role.execute!(
        { driveId: 'drive1', roleId: 'role1' },
        makeContext('admin1')
      ) as { success: boolean };

      expect(result.success).toBe(true);
    });

    it('succeeds when the role has members assigned (service cascades)', async () => {
      mockCheckAccess.mockResolvedValueOnce(adminAccess);
      mockGetRole.mockResolvedValueOnce(makeRole());
      mockDeleteRole.mockResolvedValueOnce(undefined);

      const result = await roleManagementTools.delete_drive_role.execute!(
        { driveId: 'drive1', roleId: 'role1' },
        makeContext('admin1')
      ) as { success: boolean };

      expect(result.success).toBe(true);
    });
  });
});
