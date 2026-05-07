/**
 * Shared invite-acceptance helper for native auth routes
 * (google/native, google/one-tap, apple/native).
 *
 * Web callbacks (google/callback, apple/callback) handle this inline because
 * they need to override `returnUrl` rather than emit a JSON field; native
 * routes return JSON, so the hook layer reads `invitedDriveId` and routes
 * to `/dashboard/<id>?invited=1` from there.
 */

import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  acceptInviteForExistingUser,
  acceptInviteForNewUser,
  type InviteAcceptanceErrorCode,
} from '@pagespace/lib/services/invites';
import { buildAcceptancePorts } from './invite-acceptance-adapters';

export interface NativeInviteAcceptanceInput {
  request: Request;
  inviteToken: string | undefined;
  user: { id: string; suspendedAt?: Date | null };
  isNewUser: boolean;
  email: string;
}

export interface NativeInviteAcceptanceResult {
  invitedDriveId: string | null;
  inviteError?: InviteAcceptanceErrorCode;
}

export const consumeInviteIfPresent = async ({
  request,
  inviteToken,
  user,
  isNewUser,
  email,
}: NativeInviteAcceptanceInput): Promise<NativeInviteAcceptanceResult> => {
  if (!inviteToken) return { invitedDriveId: null };

  try {
    const ports = buildAcceptancePorts(request);
    const acceptInput = {
      token: inviteToken,
      userId: user.id,
      userEmail: email.toLowerCase(),
      suspendedAt: isNewUser ? null : (user.suspendedAt ?? null),
      now: new Date(),
    };
    const result = isNewUser
      ? await acceptInviteForNewUser(ports)(acceptInput)
      : await acceptInviteForExistingUser(ports)(acceptInput);

    if (result.ok) return { invitedDriveId: result.data.driveId };
    return { invitedDriveId: null, inviteError: result.error };
  } catch (error) {
    loggers.auth.error('Invite acceptance pipe threw', error as Error);
    return { invitedDriveId: null };
  }
};
