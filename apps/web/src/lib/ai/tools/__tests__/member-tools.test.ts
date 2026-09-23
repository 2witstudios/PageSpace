import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn(),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'id', ownerId: 'ownerId' },
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', name: 'name', email: 'email', accountType: 'accountType' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  userProfiles: { userId: 'userId', displayName: 'displayName', avatarUrl: 'avatarUrl' },
}));
vi.mock('@pagespace/db/schema/social', () => ({
  connections: {
    user1Id: 'user1Id',
    user2Id: 'user2Id',
    status: 'status',
    acceptedAt: 'acceptedAt',
  },
}));
vi.mock('@pagespace/lib/auth/user-repository', () => ({
  decryptUserRow: async <T,>(row: T) => row,
  decryptUserRows: async <T,>(rows: T[]) => rows,
}));
vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  checkDriveAccess: vi.fn(),
  listDriveMembers: vi.fn(),
}));

import { memberTools } from '../member-tools';
import { db } from '@pagespace/db/db';
import { checkDriveAccess, listDriveMembers } from '@pagespace/lib/services/drive-member-service';
import type { ToolExecutionContext } from '../../core/types';

const mockCheckDriveAccess = vi.mocked(checkDriveAccess);
vi.mocked(listDriveMembers);

const makeContext = (userId: string) => ({
  toolCallId: '1',
  messages: [],
  experimental_context: { userId } as ToolExecutionContext,
});

describe('member-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list_drive_members', () => {
    it('has correct tool definition', () => {
      expect(typeof memberTools.list_drive_members).toBe('object');
      expect(typeof memberTools.list_drive_members.description).toBe('string');
      expect(memberTools.list_drive_members.description).toContain('userId');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        memberTools.list_drive_members.execute!({ driveId: 'drive1' }, context)
      ).rejects.toThrow('User authentication required');
    });

    it('returns error when drive not found', async () => {
      mockCheckDriveAccess.mockResolvedValueOnce({
        isOwner: false,
        isAdmin: false,
        isMember: false,
        drive: null,
      });

      const result = await memberTools.list_drive_members.execute!(
        { driveId: 'missing-drive' },
        makeContext('user1')
      );

      expect(result).toMatchObject({ success: false, error: 'Drive not found' });
    });

    it('returns error when user is not a member', async () => {
      mockCheckDriveAccess.mockResolvedValueOnce({
        isOwner: false,
        isAdmin: false,
        isMember: false,
        drive: { id: 'drive1', name: 'Test Drive' } as never,
      });

      const result = await memberTools.list_drive_members.execute!(
        { driveId: 'drive1' },
        makeContext('user1')
      );

      expect(result).toMatchObject({ success: false, error: expect.stringContaining('member') });
    });
  });

  describe('list_drive_members — agent accounts (Phase 2b)', () => {
    it('given an AI agent member, should label its self-chosen name for the model and carry accountType; a human is unchanged', async () => {
      mockCheckDriveAccess.mockResolvedValueOnce({
        isOwner: true, isAdmin: true, isMember: true,
        drive: { id: 'drive1', name: 'Test Drive' } as never,
      });
      const ownerChain = {
        from: vi.fn().mockReturnThis(),
        leftJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([{ id: 'owner1', name: 'Ada', email: 'ada@x.com', accountType: 'human', displayName: null, avatarUrl: null }]),
      };
      vi.mocked(db.select).mockReturnValueOnce(ownerChain as never);
      vi.mocked(listDriveMembers).mockResolvedValueOnce([{
        id: 'dm1', userId: 'agent1', role: 'MEMBER', invitedBy: null, invitedAt: null, acceptedAt: new Date(), lastAccessedAt: null,
        user: { id: 'agent1', email: 'agent-agent1@agents.pagespace.invalid', name: 'Drive Owner', accountType: 'agent' },
        profile: null, customRole: null, permissionCounts: { view: 0, edit: 0, share: 0 },
      }, {
        id: 'dm2', userId: 'human2', role: 'MEMBER', invitedBy: null, invitedAt: null, acceptedAt: new Date(), lastAccessedAt: null,
        user: { id: 'human2', email: 'h2@x.com', name: null, accountType: 'human' },
        profile: null, customRole: null, permissionCounts: { view: 0, edit: 0, share: 0 },
      }]);

      const result = await memberTools.list_drive_members.execute!({ driveId: 'drive1' }, makeContext('owner1')) as {
        members: Array<{ userId: string; displayName: string; accountType: string }>;
      };

      expect(result.members).toEqual([
        expect.objectContaining({ userId: 'owner1', name: 'Ada', displayName: 'Ada', accountType: 'human' }),
        expect.objectContaining({ userId: 'agent1', name: '[AI agent account, self-named] "Drive Owner"', displayName: '[AI agent account, self-named] "Drive Owner"', accountType: 'agent' }),
        // A human's missing name stays missing — never rewritten to a placeholder.
        expect.objectContaining({ userId: 'human2', name: null, displayName: null, accountType: 'human' }),
      ]);
    });
  });

  describe('list_collaborators', () => {
    it('has correct tool definition', () => {
      expect(typeof memberTools.list_collaborators).toBe('object');
      expect(typeof memberTools.list_collaborators.description).toBe('string');
      expect(memberTools.list_collaborators.description).toContain('user ID');
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };

      await expect(
        memberTools.list_collaborators.execute!({}, context)
      ).rejects.toThrow('User authentication required');
    });
  });
});
