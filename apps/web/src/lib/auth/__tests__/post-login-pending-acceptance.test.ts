/**
 * Unit tests for the post-login pending invitation acceptance helper.
 *
 * Mocks the repository, broadcast, and recipient-resolution seams to keep the
 * test pure and focused on orchestration semantics. Per Epic 3 scope, broadcast
 * errors must NOT propagate (acceptance is durable; missed realtime nudges are
 * recoverable on next page load) — the original PR coupled them and that
 * coupling was flagged as a flaw in review.
 */

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

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    auth: {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

import { acceptUserPendingInvitations } from '../post-login-pending-acceptance';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import {
  broadcastDriveMemberEventToRecipients,
  createDriveMemberEventPayload,
} from '@/lib/websocket';
import { getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';
import { loggers } from '@pagespace/lib/logging/logger-config';

const pendingRow = (
  id: string,
  driveId: string,
  role: 'OWNER' | 'ADMIN' | 'MEMBER' = 'MEMBER',
  driveName?: string
) => ({
  id,
  driveId,
  role,
  driveName: driveName ?? `Drive ${driveId}`,
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
    expect(getDriveRecipientUserIds).not.toHaveBeenCalled();
    expect(broadcastDriveMemberEventToRecipients).not.toHaveBeenCalled();
  });

  it('given a pending row whose conditional UPDATE succeeds, broadcasts member_added with the correct payload to drive recipients and returns the accepted row', async () => {
    vi.mocked(driveInviteRepository.findPendingMembersForUser).mockResolvedValue([
      pendingRow('mem_1', 'drive_a', 'MEMBER', 'Alpha'),
    ]);
    vi.mocked(driveInviteRepository.acceptPendingMember).mockResolvedValue(true);

    const accepted = await acceptUserPendingInvitations('user_x');

    expect(driveInviteRepository.acceptPendingMember).toHaveBeenCalledWith('mem_1');
    expect(getDriveRecipientUserIds).toHaveBeenCalledWith('drive_a');
    expect(createDriveMemberEventPayload).toHaveBeenCalledWith(
      'drive_a',
      'user_x',
      'member_added',
      { role: 'MEMBER', driveName: 'Alpha' }
    );
    expect(broadcastDriveMemberEventToRecipients).toHaveBeenCalledTimes(1);
    expect(broadcastDriveMemberEventToRecipients).toHaveBeenCalledWith(
      expect.objectContaining({
        driveId: 'drive_a',
        userId: 'user_x',
        operation: 'member_added',
        role: 'MEMBER',
        driveName: 'Alpha',
      }),
      ['admin_a', 'admin_b']
    );
    expect(accepted).toEqual([{ driveId: 'drive_a', driveName: 'Alpha', role: 'MEMBER' }]);
  });

  it('given the just-accepted user is in the drive recipient list, filters them out before broadcasting (no member_added echo to self)', async () => {
    vi.mocked(driveInviteRepository.findPendingMembersForUser).mockResolvedValue([
      pendingRow('mem_1', 'drive_a', 'MEMBER', 'Alpha'),
    ]);
    vi.mocked(driveInviteRepository.acceptPendingMember).mockResolvedValue(true);
    vi.mocked(getDriveRecipientUserIds).mockResolvedValueOnce(['admin_a', 'user_x', 'admin_b']);

    await acceptUserPendingInvitations('user_x');

    expect(broadcastDriveMemberEventToRecipients).toHaveBeenCalledTimes(1);
    expect(broadcastDriveMemberEventToRecipients).toHaveBeenCalledWith(
      expect.objectContaining({ driveId: 'drive_a', userId: 'user_x' }),
      ['admin_a', 'admin_b']
    );
  });

  it('given the just-accepted user is the only recipient (e.g. solo drive), skips the broadcast entirely', async () => {
    vi.mocked(driveInviteRepository.findPendingMembersForUser).mockResolvedValue([
      pendingRow('mem_1', 'drive_solo', 'MEMBER', 'Solo'),
    ]);
    vi.mocked(driveInviteRepository.acceptPendingMember).mockResolvedValue(true);
    vi.mocked(getDriveRecipientUserIds).mockResolvedValueOnce(['user_x']);

    const accepted = await acceptUserPendingInvitations('user_x');

    expect(broadcastDriveMemberEventToRecipients).not.toHaveBeenCalled();
    // Acceptance is still durable — the row appears in the returned list.
    expect(accepted).toEqual([{ driveId: 'drive_solo', driveName: 'Solo', role: 'MEMBER' }]);
  });

  it('given a pending row whose UPDATE returns false (concurrent acceptance), skips broadcast and is not in returned list', async () => {
    vi.mocked(driveInviteRepository.findPendingMembersForUser).mockResolvedValue([
      pendingRow('mem_race', 'drive_a'),
    ]);
    vi.mocked(driveInviteRepository.acceptPendingMember).mockResolvedValue(false);

    const accepted = await acceptUserPendingInvitations('user_x');

    expect(accepted).toEqual([]);
    expect(getDriveRecipientUserIds).not.toHaveBeenCalled();
    expect(broadcastDriveMemberEventToRecipients).not.toHaveBeenCalled();
  });

  it('given multiple pending rows across different drives, fans out to each drive\'s recipients independently', async () => {
    vi.mocked(driveInviteRepository.findPendingMembersForUser).mockResolvedValue([
      pendingRow('mem_a', 'drive_a', 'MEMBER', 'Alpha'),
      pendingRow('mem_b', 'drive_b', 'ADMIN', 'Beta'),
    ]);
    vi.mocked(driveInviteRepository.acceptPendingMember).mockResolvedValue(true);
    vi.mocked(getDriveRecipientUserIds)
      .mockResolvedValueOnce(['admin_a'])
      .mockResolvedValueOnce(['admin_b', 'admin_c']);

    const accepted = await acceptUserPendingInvitations('user_x');

    expect(driveInviteRepository.acceptPendingMember).toHaveBeenCalledTimes(2);
    expect(getDriveRecipientUserIds).toHaveBeenCalledWith('drive_a');
    expect(getDriveRecipientUserIds).toHaveBeenCalledWith('drive_b');
    expect(broadcastDriveMemberEventToRecipients).toHaveBeenCalledTimes(2);
    expect(broadcastDriveMemberEventToRecipients).toHaveBeenCalledWith(
      expect.objectContaining({ driveId: 'drive_a', role: 'MEMBER', driveName: 'Alpha' }),
      ['admin_a']
    );
    expect(broadcastDriveMemberEventToRecipients).toHaveBeenCalledWith(
      expect.objectContaining({ driveId: 'drive_b', role: 'ADMIN', driveName: 'Beta' }),
      ['admin_b', 'admin_c']
    );
    expect(accepted).toEqual([
      { driveId: 'drive_a', driveName: 'Alpha', role: 'MEMBER' },
      { driveId: 'drive_b', driveName: 'Beta', role: 'ADMIN' },
    ]);
  });

  it('given the broadcast helper throws, logs the error and continues without propagating (acceptance is durable; missed realtime nudge is recoverable)', async () => {
    vi.mocked(driveInviteRepository.findPendingMembersForUser).mockResolvedValue([
      pendingRow('mem_a', 'drive_a', 'MEMBER', 'Alpha'),
      pendingRow('mem_b', 'drive_b', 'MEMBER', 'Beta'),
    ]);
    vi.mocked(driveInviteRepository.acceptPendingMember).mockResolvedValue(true);
    vi.mocked(broadcastDriveMemberEventToRecipients)
      .mockRejectedValueOnce(new Error('realtime down'))
      .mockResolvedValueOnce(undefined);

    const accepted = await acceptUserPendingInvitations('user_x');

    // Both rows must still be in the accepted result — broadcast is best-effort.
    expect(accepted).toEqual([
      { driveId: 'drive_a', driveName: 'Alpha', role: 'MEMBER' },
      { driveId: 'drive_b', driveName: 'Beta', role: 'MEMBER' },
    ]);
    expect(loggers.auth.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to broadcast pending invite acceptance'),
      expect.any(Error),
      expect.objectContaining({ userId: 'user_x', driveId: 'drive_a' })
    );
  });

  it('given getDriveRecipientUserIds throws, logs the error and continues without propagating (recipient resolution failures must not abort login)', async () => {
    vi.mocked(driveInviteRepository.findPendingMembersForUser).mockResolvedValue([
      pendingRow('mem_a', 'drive_a', 'MEMBER', 'Alpha'),
    ]);
    vi.mocked(driveInviteRepository.acceptPendingMember).mockResolvedValue(true);
    vi.mocked(getDriveRecipientUserIds).mockRejectedValueOnce(new Error('lookup failed'));

    const accepted = await acceptUserPendingInvitations('user_x');

    expect(accepted).toEqual([{ driveId: 'drive_a', driveName: 'Alpha', role: 'MEMBER' }]);
    expect(broadcastDriveMemberEventToRecipients).not.toHaveBeenCalled();
    expect(loggers.auth.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to broadcast pending invite acceptance'),
      expect.any(Error),
      expect.objectContaining({ userId: 'user_x', driveId: 'drive_a' })
    );
  });

  it('given acceptPendingMember throws (genuine DB failure), propagates so the caller can revoke the session and abort login', async () => {
    vi.mocked(driveInviteRepository.findPendingMembersForUser).mockResolvedValue([
      pendingRow('mem_throws', 'drive_a'),
    ]);
    vi.mocked(driveInviteRepository.acceptPendingMember).mockRejectedValue(new Error('db down'));

    await expect(acceptUserPendingInvitations('user_x')).rejects.toThrow('db down');
  });

  it('given findPendingMembersForUser throws (genuine DB failure), propagates so the caller can revoke the session and abort login', async () => {
    vi.mocked(driveInviteRepository.findPendingMembersForUser).mockRejectedValue(
      new Error('connection reset')
    );

    await expect(acceptUserPendingInvitations('user_x')).rejects.toThrow('connection reset');
  });
});
