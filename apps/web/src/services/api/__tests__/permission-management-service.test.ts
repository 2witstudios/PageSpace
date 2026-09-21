import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findFirst: vi.fn() },
    },
    select: vi.fn(),
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
  driveMembers: { driveId: 'driveMembers.driveId', userId: 'driveMembers.userId', role: 'driveMembers.role', acceptedAt: 'driveMembers.acceptedAt' },
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getUserAccessLevel: vi.fn(async () => ({ canShare: true })),
  isDriveOwnerOrAdmin: vi.fn(async () => false),
}));
vi.mock('@pagespace/lib/services/drive-role-service', () => ({
  listDriveRoles: vi.fn(),
  getRoleById: vi.fn(),
  updateDriveRole: vi.fn(),
}));

import { db } from '@pagespace/db/db';
import { getRoleById, updateDriveRole } from '@pagespace/lib/services/drive-role-service';
import { getUserAccessLevel, isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import { permissionManagementService, rolePermissionService } from '../permission-management-service';

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

// canUserManagePermissions used to read drive_members for role ADMIN with no
// acceptedAt filter, so a user holding a pending (unaccepted) ADMIN invite could
// grant and revoke page permissions. The drive_members table below answers the
// query the service builds; the canonical isDriveOwnerOrAdmin mock answers what
// permissions.ts answers for the same row (pending → false, accepted → true).
describe('permissionManagementService.canUserManagePermissions — pending invites', () => {
  type MemberRow = { driveId: string; userId: string; role: string; acceptedAt: Date | null };
  type Predicate = [string, ...unknown[]];

  const mockDb = db as unknown as { select: MockFn };
  const column = (ref: unknown) => String(ref).replace(/^driveMembers\./, '') as keyof MemberRow;
  const matches = (row: MemberRow, p: Predicate): boolean => {
    const [op, ...args] = p;
    if (op === 'and') return (args as Predicate[]).every((arg) => matches(row, arg));
    if (op === 'eq') return row[column(args[0])] === args[1];
    throw new Error(`fake table cannot evaluate ${JSON.stringify(p)}`);
  };

  const seed = (row: MemberRow, canonicalAnswer: boolean) => {
    mockPagesFindFirst.mockResolvedValue({ id: 'page-1', drive: { id: 'drive-1', ownerId: 'owner-1' } });
    vi.mocked(getUserAccessLevel).mockResolvedValue({ canView: true, canEdit: false, canShare: false, canDelete: false });
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(canonicalAnswer);
    mockDb.select.mockImplementation(() => ({
      from: () => ({
        where: (where: Predicate) => ({
          limit: async () => [row].filter((r) => matches(r, where)),
        }),
      }),
    }));
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['ADMIN', 'MEMBER'])('refuses a user whose %s invite is still pending', async (role) => {
    seed({ driveId: 'drive-1', userId: 'user-1', role, acceptedAt: null }, false);

    await expect(permissionManagementService.canUserManagePermissions('user-1', 'page-1')).resolves.toBe(false);
  });

  it('allows the same user once the ADMIN invite is accepted', async () => {
    seed({ driveId: 'drive-1', userId: 'user-1', role: 'ADMIN', acceptedAt: new Date('2026-09-01') }, true);

    await expect(permissionManagementService.canUserManagePermissions('user-1', 'page-1')).resolves.toBe(true);
    expect(isDriveOwnerOrAdmin).toHaveBeenCalledWith('user-1', 'drive-1');
  });

  it('refuses an accepted MEMBER without share rights', async () => {
    seed({ driveId: 'drive-1', userId: 'user-1', role: 'MEMBER', acceptedAt: new Date('2026-09-01') }, false);

    await expect(permissionManagementService.canUserManagePermissions('user-1', 'page-1')).resolves.toBe(false);
  });

  it('allows the drive owner', async () => {
    seed({ driveId: 'drive-1', userId: 'someone-else', role: 'MEMBER', acceptedAt: new Date('2026-09-01') }, true);

    await expect(permissionManagementService.canUserManagePermissions('owner-1', 'page-1')).resolves.toBe(true);
  });

  it('refuses a non-member', async () => {
    seed({ driveId: 'drive-1', userId: 'someone-else', role: 'ADMIN', acceptedAt: new Date('2026-09-01') }, false);

    await expect(permissionManagementService.canUserManagePermissions('user-1', 'page-1')).resolves.toBe(false);
  });

  it('allows anyone the page-level resolver already lets share, without a membership read', async () => {
    seed({ driveId: 'drive-1', userId: 'someone-else', role: 'MEMBER', acceptedAt: null }, false);
    vi.mocked(getUserAccessLevel).mockResolvedValue({ canView: true, canEdit: true, canShare: true, canDelete: false });

    await expect(permissionManagementService.canUserManagePermissions('user-1', 'page-1')).resolves.toBe(true);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('X-6 (partial) a stale source=org ADMIN row manages nothing: the org-aware isDriveOwnerOrAdmin refuses, and the service reads no drive_members row of its own', async () => {
    seed({ driveId: 'drive-1', userId: 'user-1', role: 'ADMIN', acceptedAt: new Date('2026-09-01') }, false);

    await expect(permissionManagementService.canUserManagePermissions('user-1', 'page-1')).resolves.toBe(false);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('ORG-4 (partial) an org Admin with no drive_members row manages page permissions on an org drive', async () => {
    seed({ driveId: 'drive-1', userId: 'someone-else', role: 'MEMBER', acceptedAt: null }, true);

    await expect(permissionManagementService.canUserManagePermissions('org-admin-1', 'page-1')).resolves.toBe(true);
    expect(isDriveOwnerOrAdmin).toHaveBeenCalledWith('org-admin-1', 'drive-1');
  });
});
