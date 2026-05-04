import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: {
    findPendingMembersForUser: vi.fn(),
    acceptPendingMember: vi.fn(),
  },
}));

vi.mock('@/lib/websocket', () => ({
  broadcastDriveMemberEventToRecipients: vi.fn().mockResolvedValue(undefined),
  createDriveMemberEventPayload: vi.fn(
    (driveId: string, userId: string, operation: string, data: unknown) => ({
      driveId,
      userId,
      operation,
      ...(data as Record<string, unknown>),
    })
  ),
}));

vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveRecipientUserIds: vi.fn().mockResolvedValue(['admin_a', 'admin_b']),
}));

import { acceptUserPendingInvitations } from '../post-login-pending-acceptance';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { broadcastDriveMemberEventToRecipients } from '@/lib/websocket';
import { getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';

const pendingRow = (id: string, driveId: string, role: 'OWNER' | 'ADMIN' | 'MEMBER' = 'MEMBER') => ({
  id,
  driveId,
  role,
  driveName: `Drive ${driveId}`,
});

describe('acceptUserPendingInvitations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDriveRecipientUserIds).mockResolvedValue(['admin_a', 'admin_b']);
  });

  it('given no pending rows, resolves to an empty array and does not broadcast', async () => {
    vi.mocked(driveInviteRepository.findPendingMembersForUser).mockResolvedValue([]);

    const accepted = await acceptUserPendingInvitations('user_x');

    expect(accepted).toEqual([]);
    expect(driveInviteRepository.acceptPendingMember).not.toHaveBeenCalled();
    expect(broadcastDriveMemberEventToRecipients).not.toHaveBeenCalled();
  });

  it('given a pending row whose conditional UPDATE succeeds, broadcasts member_added and returns the accepted row', async () => {
    vi.mocked(driveInviteRepository.findPendingMembersForUser).mockResolvedValue([
      pendingRow('mem_1', 'drive_a'),
    ]);
    vi.mocked(driveInviteRepository.acceptPendingMember).mockResolvedValue(true);

    const accepted = await acceptUserPendingInvitations('user_x');

    expect(driveInviteRepository.acceptPendingMember).toHaveBeenCalledWith('mem_1');
    expect(broadcastDriveMemberEventToRecipients).toHaveBeenCalledTimes(1);
    expect(accepted).toEqual([{ driveId: 'drive_a', driveName: 'Drive drive_a', role: 'MEMBER' }]);
  });

  it('given a pending row whose conditional UPDATE returns false (concurrent acceptance), skips broadcast and is not in returned list', async () => {
    vi.mocked(driveInviteRepository.findPendingMembersForUser).mockResolvedValue([
      pendingRow('mem_race', 'drive_a'),
    ]);
    vi.mocked(driveInviteRepository.acceptPendingMember).mockResolvedValue(false);

    const accepted = await acceptUserPendingInvitations('user_x');

    expect(accepted).toEqual([]);
    expect(broadcastDriveMemberEventToRecipients).not.toHaveBeenCalled();
  });

  it('given multiple pending rows across different drives, fans out to each drive\'s recipients independently', async () => {
    vi.mocked(driveInviteRepository.findPendingMembersForUser).mockResolvedValue([
      pendingRow('mem_a', 'drive_a'),
      pendingRow('mem_b', 'drive_b', 'ADMIN'),
    ]);
    vi.mocked(driveInviteRepository.acceptPendingMember).mockResolvedValue(true);

    const accepted = await acceptUserPendingInvitations('user_x');

    expect(driveInviteRepository.acceptPendingMember).toHaveBeenCalledTimes(2);
    expect(getDriveRecipientUserIds).toHaveBeenCalledWith('drive_a');
    expect(getDriveRecipientUserIds).toHaveBeenCalledWith('drive_b');
    expect(broadcastDriveMemberEventToRecipients).toHaveBeenCalledTimes(2);
    expect(accepted).toHaveLength(2);
  });

  it('given acceptPendingMember throws, propagates the error so the caller can revoke the session and abort login', async () => {
    vi.mocked(driveInviteRepository.findPendingMembersForUser).mockResolvedValue([
      pendingRow('mem_throws', 'drive_a'),
    ]);
    vi.mocked(driveInviteRepository.acceptPendingMember).mockRejectedValue(new Error('db down'));

    await expect(acceptUserPendingInvitations('user_x')).rejects.toThrow('db down');
  });

  it('given broadcast throws after a row is accepted, propagates the error so the caller fails the login (acceptance is durable, but admins miss the realtime nudge)', async () => {
    vi.mocked(driveInviteRepository.findPendingMembersForUser).mockResolvedValue([
      pendingRow('mem_bcast', 'drive_a'),
    ]);
    vi.mocked(driveInviteRepository.acceptPendingMember).mockResolvedValue(true);
    vi.mocked(broadcastDriveMemberEventToRecipients).mockRejectedValueOnce(
      new Error('realtime down')
    );

    await expect(acceptUserPendingInvitations('user_x')).rejects.toThrow('realtime down');
  });
});
