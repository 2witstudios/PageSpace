/**
 * Post-login pending invitation acceptance.
 *
 * After a user successfully creates a session via ANY auth flow (magic link,
 * passkey, Google, Apple, mobile OAuth), accept any drive invitations that are
 * pending for them. The acceptedAt-IS-NOT-NULL filter on authorization queries
 * is the gate for drive access — without this hook, an invitee with a pending
 * drive_members row would authenticate but be unable to reach the drive they
 * were invited to.
 *
 * Acceptance writes propagate (a genuine DB failure must let the caller revoke
 * the just-created session). Broadcast and recipient-resolution failures are
 * logged but swallowed — acceptance is durable and missed realtime nudges are
 * recoverable on the next page load. The original PR coupled broadcast errors
 * to login revocation; that coupling was flagged in review and is intentionally
 * not repeated here.
 */

import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import {
  broadcastDriveMemberEventToRecipients,
  createDriveMemberEventPayload,
} from '@/lib/websocket';
import { getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';
import { loggers } from '@pagespace/lib/logging/logger-config';

export interface AcceptedInvitation {
  driveId: string;
  driveName: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}

export async function acceptUserPendingInvitations(
  userId: string
): Promise<AcceptedInvitation[]> {
  const pending = await driveInviteRepository.findPendingMembersForUser(userId);
  const accepted: AcceptedInvitation[] = [];

  for (const row of pending) {
    const wasAccepted = await driveInviteRepository.acceptPendingMember(row.id);
    if (!wasAccepted) continue;

    accepted.push({
      driveId: row.driveId,
      driveName: row.driveName,
      role: row.role,
    });

    try {
      const driveRecipients = await getDriveRecipientUserIds(row.driveId);
      await broadcastDriveMemberEventToRecipients(
        createDriveMemberEventPayload(row.driveId, userId, 'member_added', {
          role: row.role,
          driveName: row.driveName,
        }),
        driveRecipients
      );
    } catch (error) {
      loggers.auth.error(
        'Failed to broadcast pending invite acceptance',
        error instanceof Error ? error : new Error(String(error)),
        { userId, driveId: row.driveId }
      );
    }
  }

  return accepted;
}
