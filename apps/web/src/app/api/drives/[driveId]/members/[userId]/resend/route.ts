import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { createMagicLinkToken, INVITATION_LINK_EXPIRY_MINUTES } from '@pagespace/lib/auth/magic-link-service';
import { sendPendingDriveInvitationEmail } from '@pagespace/lib/services/notification-email-service';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

const RESEND_RATE_LIMIT = {
  maxAttempts: 3,
  windowMs: 24 * 60 * 60 * 1000,
  blockDurationMs: 24 * 60 * 60 * 1000,
  progressiveDelay: false,
};

export async function POST(
  request: Request,
  context: { params: Promise<{ driveId: string; userId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const callerId = auth.userId;

    const { driveId, userId: targetUserId } = await context.params;

    const emailVerified = await isEmailVerified(callerId);
    if (!emailVerified) {
      return NextResponse.json(
        { error: 'Email verification required.', requiresEmailVerification: true },
        { status: 403 }
      );
    }

    const drive = await driveInviteRepository.findDriveById(driveId);
    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    const isOwner = drive.ownerId === callerId;
    let isAdmin = false;
    if (!isOwner) {
      const adminMembership = await driveInviteRepository.findAdminMembership(driveId, callerId);
      isAdmin = adminMembership !== null;
    }
    if (!isOwner && !isAdmin) {
      auditRequest(request, {
        eventType: 'authz.access.denied',
        userId: callerId,
        resourceType: 'drive',
        resourceId: driveId,
        details: { targetUserId, operation: 'resend_invitation', reason: 'not_owner_or_admin' },
      });
      return NextResponse.json(
        { error: 'Only drive owners and admins can resend invitations' },
        { status: 403 }
      );
    }

    const member = await driveInviteRepository.findExistingMember(driveId, targetUserId);
    if (!member) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }
    if (member.acceptedAt) {
      return NextResponse.json(
        { error: 'Invitation already accepted; nothing to resend' },
        { status: 400 }
      );
    }

    const rateLimit = await checkDistributedRateLimit(
      `drive_invite_resend:${driveId}:${targetUserId}`,
      RESEND_RATE_LIMIT
    );
    if (!rateLimit.allowed) {
      auditRequest(request, {
        eventType: 'security.rate.limited',
        userId: callerId,
        resourceType: 'drive',
        resourceId: driveId,
        details: { targetUserId, operation: 'resend_invitation' },
      });
      return NextResponse.json(
        { error: 'Too many resend attempts. Please try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': String(rateLimit.retryAfter ?? 3600) },
        }
      );
    }

    const recipientEmail = await driveInviteRepository.findUserEmail(targetUserId);
    if (!recipientEmail) {
      return NextResponse.json({ error: 'Pending invitee has no email on file' }, { status: 404 });
    }

    const tokenResult = await createMagicLinkToken({
      email: recipientEmail,
      expiryMinutes: INVITATION_LINK_EXPIRY_MINUTES,
    });
    if (!tokenResult.ok) {
      if (tokenResult.error.code === 'USER_SUSPENDED') {
        return NextResponse.json(
          { error: 'This account is suspended and cannot receive invitations.' },
          { status: 403 }
        );
      }
      loggers.api.error('Failed to create magic link token for resend', new Error(tokenResult.error.code));
      return NextResponse.json({ error: 'Failed to resend invitation' }, { status: 500 });
    }

    const appUrl =
      process.env.WEB_APP_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      'http://localhost:3000';
    const magicLinkUrl = `${appUrl}/api/auth/magic-link/verify?token=${encodeURIComponent(tokenResult.data.token)}&inviteDriveId=${encodeURIComponent(driveId)}`;
    const inviter = await driveInviteRepository.findInviterDisplay(callerId);

    await sendPendingDriveInvitationEmail({
      recipientEmail,
      inviterName: inviter?.name || 'A PageSpace user',
      driveName: drive.name,
      magicLinkUrl,
    });

    await driveInviteRepository.bumpInvitedAt(member.id);

    auditRequest(request, {
      eventType: 'data.share',
      userId: callerId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { targetUserId, operation: 'resend_invitation' },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error resending invitation:', error as Error);
    return NextResponse.json({ error: 'Failed to resend invitation' }, { status: 500 });
  }
}
