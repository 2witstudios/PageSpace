import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import {
  createMagicLinkToken,
  INVITATION_LINK_EXPIRY_MINUTES,
} from '@pagespace/lib/auth/magic-link-service';
import { sendPendingDriveInvitationEmail } from '@pagespace/lib/services/notification-email-service';
import {
  checkDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security/distributed-rate-limit';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

function resolveAppUrl(): string | null {
  const url = process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!url) return null;
  return url.replace(/\/+$/, '');
}

export async function POST(
  request: Request,
  context: { params: Promise<{ driveId: string; userId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const inviterUserId = auth.userId;

    const { driveId, userId: targetUserId } = await context.params;

    const emailVerified = await isEmailVerified(inviterUserId);
    if (!emailVerified) {
      return NextResponse.json(
        {
          error: 'Email verification required. Please verify your email to perform this action.',
          requiresEmailVerification: true,
        },
        { status: 403 }
      );
    }

    const drive = await driveInviteRepository.findDriveById(driveId);
    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    const isOwner = drive.ownerId === inviterUserId;
    let isAcceptedAdmin = false;
    if (!isOwner) {
      // findAdminMembership filters acceptedAt IS NOT NULL — Epic 1's gate.
      const adminMembership = await driveInviteRepository.findAdminMembership(driveId, inviterUserId);
      isAcceptedAdmin = adminMembership !== null;
    }
    if (!isOwner && !isAcceptedAdmin) {
      auditRequest(request, {
        eventType: 'authz.access.denied',
        userId: inviterUserId,
        resourceType: 'drive',
        resourceId: driveId,
        details: { targetUserId, operation: 'resend_invitation' },
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
    if (member.acceptedAt !== null) {
      return NextResponse.json(
        { error: 'Member has already accepted the invitation.' },
        { status: 400 }
      );
    }

    const targetEmail = await driveInviteRepository.findUserEmail(targetUserId);
    if (!targetEmail) {
      return NextResponse.json(
        { error: 'No email on file for this pending member.' },
        { status: 404 }
      );
    }

    const rateLimitKey = `drive_invite_resend:${driveId}:${targetUserId}`;
    const rl = await checkDistributedRateLimit(
      rateLimitKey,
      DISTRIBUTED_RATE_LIMITS.DRIVE_INVITE_RESEND
    );
    if (!rl.allowed) {
      auditRequest(request, {
        eventType: 'security.rate.limited',
        userId: inviterUserId,
        resourceType: 'drive',
        resourceId: driveId,
        details: {
          targetUserId,
          operation: 'resend_invitation',
          retryAfter: rl.retryAfter,
        },
      });
      return NextResponse.json(
        { error: 'Too many resend attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfter ?? 86400) } }
      );
    }

    const appUrl = resolveAppUrl();
    if (!appUrl) {
      loggers.api.error(
        'Drive invite resend cannot be sent: WEB_APP_URL and NEXT_PUBLIC_APP_URL both unset'
      );
      return NextResponse.json(
        { error: 'Email delivery is not configured on this deployment.' },
        { status: 500 }
      );
    }

    const tokenResult = await createMagicLinkToken({
      email: targetEmail,
      expiryMinutes: INVITATION_LINK_EXPIRY_MINUTES,
    });

    if (!tokenResult.ok) {
      if (tokenResult.error.code === 'USER_SUSPENDED') {
        return NextResponse.json(
          { error: 'This account is suspended and cannot be invited.' },
          { status: 403 }
        );
      }
      loggers.api.error('Failed to create magic link token for drive invite resend', undefined, {
        code: tokenResult.error.code,
      });
      return NextResponse.json({ error: 'Failed to resend invitation' }, { status: 500 });
    }

    const inviter = await driveInviteRepository.findInviterDisplay(inviterUserId);
    const magicLinkUrl = `${appUrl}/api/auth/magic-link/verify?token=${encodeURIComponent(tokenResult.data.token)}`;

    try {
      await sendPendingDriveInvitationEmail({
        recipientEmail: targetEmail,
        inviterName: inviter?.name ?? 'A teammate',
        driveName: drive.name,
        magicLinkUrl,
      });
    } catch (emailError) {
      loggers.api.error(
        'Failed to send drive invitation resend email',
        emailError instanceof Error ? emailError : new Error(String(emailError)),
        { driveId, targetUserId, recipientEmail: targetEmail }
      );
      return NextResponse.json(
        { error: 'Failed to send invitation email. Please try again.' },
        { status: 502 }
      );
    }

    await driveInviteRepository.bumpInvitedAt(member.id);

    auditRequest(request, {
      eventType: 'data.share',
      userId: inviterUserId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { targetUserId, operation: 'resend_invitation' },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error resending drive invitation:', error as Error);
    return NextResponse.json({ error: 'Failed to resend invitation' }, { status: 500 });
  }
}
