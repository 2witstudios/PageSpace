import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db', () => {
  const eq = vi.fn((a, b) => ({ op: 'eq', a, b }));
  const and = vi.fn((...args: unknown[]) => ({ op: 'and', args }));
  const sql = vi.fn();

  return {
    db: {
      query: {
        drives: { findFirst: vi.fn() },
      },
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
          leftJoin: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ id: 'new' }]),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn().mockResolvedValue(undefined),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
      execute: vi.fn(),
    },
    driveMembers: { id: 'dm.id', driveId: 'dm.driveId', userId: 'dm.userId', role: 'dm.role', invitedBy: 'dm.invitedBy', invitedAt: 'dm.invitedAt', acceptedAt: 'dm.acceptedAt', lastAccessedAt: 'dm.lastAccessedAt', customRoleId: 'dm.customRoleId' },
    drives: { id: 'drives.id', ownerId: 'drives.ownerId' },
    users: { id: 'users.id', email: 'users.email', name: 'users.name' },
    userProfiles: { username: 'up.username', displayName: 'up.displayName', avatarUrl: 'up.avatarUrl', userId: 'up.userId' },
    driveRoles: { id: 'dr.id', name: 'dr.name', color: 'dr.color' },
    pagePermissions: { pageId: 'pp.pageId', userId: 'pp.userId', canView: 'pp.canView', canEdit: 'pp.canEdit', canShare: 'pp.canShare', grantedBy: 'pp.grantedBy', grantedAt: 'pp.grantedAt' },
    pages: { id: 'pages.id', driveId: 'pages.driveId' },
    eq, and, sql,
  };
});

import { db } from '@pagespace/db';
import {
  checkDriveAccess,
  getDriveMemberUserIds,
  getDriveRecipientUserIds,
  isMemberOfDrive,
  addDriveMember,
  getDriveMemberDetails,
  getMemberPermissions,
  updateMemberRole,
  updateMemberPermissions,
  listDriveMembers,
} from '../drive-member-service';

const mockDb = vi.mocked(db);

describe('drive-member-service @scaffold', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset defaults
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        leftJoin: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      }),
    });
  });

  describe('checkDriveAccess', () => {
    it('should return all false when drive not found', async () => {
      mockDb.query.drives.findFirst.mockResolvedValueOnce(null);

      const result = await checkDriveAccess('drive-1', 'user-1');
      expect(result.drive).toBeNull();
      expect(result.isOwner).toBe(false);
    });

    it('should return owner access when user is owner', async () => {
      mockDb.query.drives.findFirst.mockResolvedValueOnce({ id: 'drive-1', ownerId: 'user-1' });

      const result = await checkDriveAccess('drive-1', 'user-1');
      expect(result.isOwner).toBe(true);
      expect(result.isAdmin).toBe(true);
      expect(result.isMember).toBe(true);
    });

    it('should return admin access for ADMIN role', async () => {
      mockDb.query.drives.findFirst.mockResolvedValueOnce({ id: 'drive-1', ownerId: 'other' });
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ role: 'ADMIN' }]),
          }),
        }),
      });

      const result = await checkDriveAccess('drive-1', 'user-1');
      expect(result.isAdmin).toBe(true);
      expect(result.isMember).toBe(true);
      expect(result.isOwner).toBe(false);
    });

    it('should return member for MEMBER role', async () => {
      mockDb.query.drives.findFirst.mockResolvedValueOnce({ id: 'drive-1', ownerId: 'other' });
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ role: 'MEMBER' }]),
          }),
        }),
      });

      const result = await checkDriveAccess('drive-1', 'user-1');
      expect(result.isAdmin).toBe(false);
      expect(result.isMember).toBe(true);
    });

    it('should return non-member when no membership found', async () => {
      mockDb.query.drives.findFirst.mockResolvedValueOnce({ id: 'drive-1', ownerId: 'other' });
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await checkDriveAccess('drive-1', 'user-1');
      expect(result.isMember).toBe(false);
      expect(result.drive).not.toBeNull();
    });
  });

  describe('getDriveMemberUserIds', () => {
    it('should return array of user IDs', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]),
        }),
      });

      const result = await getDriveMemberUserIds('drive-1');
      expect(result).toEqual(['u1', 'u2']);
    });
  });

  describe('getDriveRecipientUserIds', () => {
    it('should return empty when drive not found', async () => {
      mockDb.query.drives.findFirst.mockResolvedValueOnce(null);

      const result = await getDriveRecipientUserIds('drive-1');
      expect(result).toEqual([]);
    });

    it('should include owner and members', async () => {
      mockDb.query.drives.findFirst.mockResolvedValueOnce({ ownerId: 'owner-1' });
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ userId: 'member-1' }, { userId: 'owner-1' }]),
        }),
      });

      const result = await getDriveRecipientUserIds('drive-1');
      expect(result).toContain('owner-1');
      expect(result).toContain('member-1');
      // Deduplicated
      expect(result).toHaveLength(2);
    });
  });

  describe('isMemberOfDrive', () => {
    it('should return true when member exists', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'dm-1' }]),
          }),
        }),
      });

      expect(await isMemberOfDrive('drive-1', 'user-1')).toBe(true);
    });

    it('should return false when not a member', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      expect(await isMemberOfDrive('drive-1', 'user-1')).toBe(false);
    });
  });

  describe('addDriveMember', () => {
    it('should insert and return member', async () => {
      const newMember = { id: 'dm-new', userId: 'u1', role: 'MEMBER' };
      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([newMember]),
        }),
      });

      const result = await addDriveMember('drive-1', 'inviter-1', { userId: 'u1' });
      expect(result.id).toBe('dm-new');
    });
  });

  describe('getDriveMemberDetails', () => {
    it('should return null when not found', async () => {
      const chain = {
        leftJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      };
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue(chain),
      });

      const result = await getDriveMemberDetails('drive-1', 'user-1');
      expect(result).toBeNull();
    });

    it('should return member details', async () => {
      const member = {
        id: 'dm-1', userId: 'user-1', role: 'MEMBER', customRoleId: null,
        invitedBy: 'owner-1', invitedAt: null, acceptedAt: new Date(), lastAccessedAt: null,
        user: { id: 'user-1', email: 'a@b.com', name: 'Test' },
        profile: { username: 'test', displayName: 'Test', avatarUrl: null },
      };
      const chain = {
        leftJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([member]),
        }),
      };
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue(chain),
      });

      const result = await getDriveMemberDetails('drive-1', 'user-1');
      expect(result).not.toBeNull();
      expect(result!.userId).toBe('user-1');
      expect(result!.customRole).toBeNull();
    });
  });

  describe('getMemberPermissions', () => {
    it('should return permissions', async () => {
      const perms = [{ pageId: 'p-1', canView: true, canEdit: false, canShare: false }];
      const chain = {
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(perms),
      };
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue(chain),
      });

      const result = await getMemberPermissions('drive-1', 'user-1');
      expect(result).toEqual(perms);
    });
  });

  describe('updateMemberRole', () => {
    it('should update and return old role', async () => {
      // Select existing role
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ role: 'MEMBER' }]),
          }),
        }),
      });

      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const result = await updateMemberRole('drive-1', 'user-1', 'ADMIN');
      expect(result.oldRole).toBe('MEMBER');
    });

    it('should default to MEMBER when no existing role', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const result = await updateMemberRole('drive-1', 'user-1', 'ADMIN');
      expect(result.oldRole).toBe('MEMBER');
    });
  });

  describe('updateMemberPermissions', () => {
    it('should replace permissions and return count', async () => {
      // First call: pages in drive
      // Second call: existing permissions
      mockDb.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnThis(),
            where: vi.fn().mockResolvedValue([{ pageId: 'p-1' }]),
          }),
        });

      mockDb.delete.mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      mockDb.insert.mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      const result = await updateMemberPermissions('drive-1', 'user-1', 'admin-1', [
        { pageId: 'p-1', canView: true, canEdit: true, canShare: false },
        { pageId: 'p-2', canView: true, canEdit: false, canShare: false },
        { pageId: 'invalid', canView: true, canEdit: false, canShare: false }, // not in drive
      ]);
      expect(result).toBe(2);
    });
  });

  describe('listDriveMembers', () => {
    it('should return members with permission counts', async () => {
      const members = [
        { userId: 'u1', role: 'MEMBER', id: 'dm-1', invitedBy: null, invitedAt: null, acceptedAt: null, lastAccessedAt: null, user: { id: 'u1', email: 'a@b.com', name: 'A' }, profile: { username: 'a', displayName: 'A', avatarUrl: null }, customRole: { id: null, name: null, color: null } },
      ];
      const chain = {
        leftJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(members),
      };
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue(chain),
      });

      mockDb.execute.mockResolvedValue({
        rows: [{ view_count: '3', edit_count: '1', share_count: '0' }],
      });

      const result = await listDriveMembers('drive-1');
      expect(result).toHaveLength(1);
      expect(result[0].permissionCounts).toEqual({ view: 3, edit: 1, share: 0 });
    });
  });
});
