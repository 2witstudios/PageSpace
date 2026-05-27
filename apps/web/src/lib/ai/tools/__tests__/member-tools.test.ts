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
  users: { id: 'id', name: 'name', email: 'email' },
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
vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  checkDriveAccess: vi.fn(),
  listDriveMembers: vi.fn(),
}));

import { memberTools } from '../member-tools';
import { checkDriveAccess, listDriveMembers } from '@pagespace/lib/services/drive-member-service';
import type { ToolExecutionContext } from '../../core';

const mockCheckDriveAccess = vi.mocked(checkDriveAccess);
const mockListDriveMembers = vi.mocked(listDriveMembers);

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
