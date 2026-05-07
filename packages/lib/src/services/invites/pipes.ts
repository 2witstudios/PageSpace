import type { AcceptancePorts } from './ports';
import type {
  AcceptedInviteData,
  AcceptInviteInput,
  AcceptInviteResult,
} from './types';
import { validateInviteForUser } from './validators';

/**
 * Shared side-effect step used by both acceptance pipes. Fires broadcast,
 * notify, track, and audit ports in sequence; never duplicated across
 * acceptForExisting / acceptForNew.
 */
const emitAcceptanceSideEffects = async (
  ports: AcceptancePorts,
  data: AcceptedInviteData,
): Promise<void> => {
  await ports.broadcastMemberAdded(data);
  await ports.notifyMemberAdded(data);
  ports.trackInviteMember({ ...data, permissionsGranted: 0 });
  ports.auditPermissionGranted(data);
};

export const acceptInviteForExistingUser =
  (ports: AcceptancePorts) =>
  async (input: AcceptInviteInput): Promise<AcceptInviteResult> => {
    const invite = await ports.loadInvite({ token: input.token });
    if (!invite) return { ok: false, error: 'TOKEN_NOT_FOUND' };

    const validated = validateInviteForUser({
      invite,
      userEmail: input.userEmail,
      suspendedAt: input.suspendedAt ?? null,
      now: input.now,
    });
    if (!validated.ok) return validated;

    const existing = await ports.findExistingMembership({
      driveId: invite.driveId,
      userId: input.userId,
    });
    if (existing && existing.acceptedAt !== null) {
      return { ok: false, error: 'ALREADY_MEMBER' };
    }

    const consumed = await ports.consumeInviteAndCreateMember({
      invite,
      userId: input.userId,
      now: input.now,
    });
    if (!consumed.ok) return { ok: false, error: consumed.reason };

    const data: AcceptedInviteData = {
      inviteId: invite.id,
      inviteEmail: invite.email,
      memberId: consumed.memberId,
      driveId: invite.driveId,
      driveName: invite.driveName,
      role: invite.role,
      invitedUserId: input.userId,
      inviterUserId: invite.invitedBy,
    };

    await emitAcceptanceSideEffects(ports, data);

    return { ok: true, data };
  };
