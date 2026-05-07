import { MAGIC_LINK_EXPIRY_MINUTES } from '../../auth/magic-link-service';
import type { AcceptancePorts, MagicLinkPorts, RevokePorts } from './ports';
import type {
  AcceptedInviteData,
  AcceptInviteInput,
  AcceptInviteResult,
  RequestMagicLinkInput,
  RequestMagicLinkResult,
  RevokePendingInviteInput,
  RevokePendingInviteResult,
} from './types';
import {
  validateInviteForUser,
  validateMagicLinkRequest,
  validateRevokeRequest,
} from './validators';

// Defense-in-depth wrapper. Adapter contract is "ports never throw"; this
// guard ensures a buggy adapter cannot reverse a successful membership write
// (consume already committed) by surfacing a side-effect failure as a 500.
const swallow = async (op: () => unknown | Promise<unknown>): Promise<void> => {
  try {
    await op();
  } catch {
    // Adapter is responsible for logging. Pipe stays pure.
  }
};

/**
 * Shared post-acceptance fanout. Routes that add a user to a drive (invite
 * acceptance via either pipe, or OWNER/ADMIN direct-add via members/invite)
 * MUST go through this helper so a future 5th side-effect port can never be
 * silently dropped on one path.
 */
export const emitAcceptanceSideEffects = async (
  ports: AcceptancePorts,
  data: AcceptedInviteData,
  permissionsGranted = 0,
): Promise<void> => {
  await swallow(() => ports.broadcastMemberAdded(data));
  await swallow(() => ports.notifyMemberAdded(data));
  await swallow(() => ports.trackInviteMember({ ...data, permissionsGranted }));
  await swallow(() => ports.auditPermissionGranted(data));
};

export const acceptInviteForExistingUser =
  (ports: AcceptancePorts) =>
  async (input: AcceptInviteInput): Promise<AcceptInviteResult> => {
    const invite = await ports.loadInvite({ token: input.token });
    if (!invite) return { ok: false, error: 'TOKEN_NOT_FOUND' };

    const validated = validateInviteForUser({
      invite,
      userEmail: input.userEmail,
      suspendedAt: input.suspendedAt,
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

export const revokePendingInvite =
  (ports: RevokePorts) =>
  async (input: RevokePendingInviteInput): Promise<RevokePendingInviteResult> => {
    const [invite, actorMembership] = await Promise.all([
      ports.loadPendingInviteForDrive({
        inviteId: input.inviteId,
        driveId: input.driveId,
      }),
      ports.findActorMembership({
        driveId: input.driveId,
        actorId: input.actorId,
      }),
    ]);

    const validated = validateRevokeRequest({
      invite,
      requestedDriveId: input.driveId,
      actorMembership,
    });
    if (!validated.ok) return validated;

    await ports.deletePendingInviteForDrive({
      inviteId: validated.data.id,
      driveId: validated.data.driveId,
    });
    await swallow(() =>
      ports.auditPermissionRevoked({
        inviteId: validated.data.id,
        driveId: validated.data.driveId,
        actorId: input.actorId,
        targetEmail: validated.data.email,
        role: validated.data.role,
      }),
    );

    return {
      ok: true,
      data: {
        inviteId: validated.data.id,
        driveId: validated.data.driveId,
        email: validated.data.email,
        role: validated.data.role,
      },
    };
  };

export const requestMagicLink =
  (ports: MagicLinkPorts) =>
  async (input: RequestMagicLinkInput): Promise<RequestMagicLinkResult> => {
    const user = await ports.loadUserByEmail({ email: input.email });
    const validated = validateMagicLinkRequest({ user });
    if (!validated.ok) return validated;

    const expiryMinutes = input.expiryMinutes ?? MAGIC_LINK_EXPIRY_MINUTES;
    const expiresAt = new Date(input.now.getTime() + expiryMinutes * 60_000);

    const { token } = await ports.createTokenAndPersist({
      userId: validated.data.id,
      expiresAt,
      ...(input.platform !== undefined && { platform: input.platform }),
      ...(input.deviceId !== undefined && { deviceId: input.deviceId }),
      ...(input.deviceName !== undefined && { deviceName: input.deviceName }),
    });

    await ports.sendMagicLinkEmail({ email: input.email, token });

    return { ok: true, data: undefined };
  };

export const acceptInviteForNewUser =
  (ports: AcceptancePorts) =>
  async (input: AcceptInviteInput): Promise<AcceptInviteResult> => {
    const invite = await ports.loadInvite({ token: input.token });
    if (!invite) return { ok: false, error: 'TOKEN_NOT_FOUND' };

    const validated = validateInviteForUser({
      invite,
      userEmail: input.userEmail,
      suspendedAt: input.suspendedAt,
      now: input.now,
    });
    if (!validated.ok) return validated;

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
