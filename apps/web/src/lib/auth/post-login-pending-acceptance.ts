/**
 * Post-login pending invitation acceptance.
 *
 * After a user successfully creates a session via ANY auth flow (magic link,
 * passkey, Google, Apple, etc.), accept any drive invitations that are pending
 * for them. The acceptedAt-IS-NOT-NULL filter on authorization queries is the
 * gate for drive access, so without this hook a passkey user with a pending
 * invitation would authenticate but be unable to reach the drive they were
 * invited to.
 *
 * Throws on any per-row failure so callers can decide whether to revoke the
 * session and surface an error.
 */

import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import {
  broadcastDriveMemberEventToRecipients,
  createDriveMemberEventPayload,
} from '@/lib/websocket';
import { getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';

export interface AcceptedInvitation {
  driveId: string;
  driveName: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}

/**
 * Accept any pending drive invitations for the user.
 *
 * Returns the rows that this call transitioned from pending → accepted. Rows
 * that were already accepted by a concurrent request are skipped silently
 * (the conditional UPDATE returns false). Each accepted row triggers a
 * `member_added` fan-out to drive recipients so admins watching the members
 * page see the realtime promotion.
 */
export async function acceptUserPendingInvitations(
  userId: string
): Promise<AcceptedInvitation[]> {
  const pending = await driveInviteRepository.findPendingMembersForUser(userId);
  const accepted: AcceptedInvitation[] = [];

  for (const row of pending) {
    const wasAccepted = await driveInviteRepository.acceptPendingMember(row.id);
    if (!wasAccepted) continue;

    const driveRecipients = await getDriveRecipientUserIds(row.driveId);
    await broadcastDriveMemberEventToRecipients(
      createDriveMemberEventPayload(row.driveId, userId, 'member_added', {
        role: row.role,
        driveName: row.driveName,
      }),
      driveRecipients
    );

    accepted.push({
      driveId: row.driveId,
      driveName: row.driveName,
      role: row.role,
    });
  }

  return accepted;
}
