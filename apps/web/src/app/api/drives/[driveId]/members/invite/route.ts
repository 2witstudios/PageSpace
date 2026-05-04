import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { createDriveNotification } from '@pagespace/lib/notifications/notifications'
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { broadcastDriveMemberEvent, createDriveMemberEventPayload } from '@/lib/websocket';
import { getActorInfo, logMemberActivity } from '@pagespace/lib/monitoring/activity-logger';
import { trackDriveOperation } from '@pagespace/lib/monitoring/activity-tracker';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { createMagicLinkToken, INVITATION_LINK_EXPIRY_MINUTES } from '@pagespace/lib/auth/magic-link-service';
import { sendPendingDriveInvitationEmail } from '@pagespace/lib/services/notification-email-service';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

interface PermissionEntry {
  pageId: string;
  canView: boolean;
  canEdit: boolean;
  canShare: boolean;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId } = await context.params;

    // Check email verification
    const emailVerified = await isEmailVerified(userId);
    if (!emailVerified) {
      return NextResponse.json(
        {
          error: 'Email verification required. Please verify your email to perform this action.',
          requiresEmailVerification: true
        },
        { status: 403 }
      );
    }

    const body = await request.json();
    const {
      userId: bodyUserId,
      email: bodyEmail,
      role = 'MEMBER',
      customRoleId,
      permissions,
    } = body as {
      userId?: string;
      email?: string;
      role?: 'MEMBER' | 'ADMIN';
      customRoleId?: string | null;
      permissions: PermissionEntry[];
    };

    // Check if user is drive owner or admin
    const drive = await driveInviteRepository.findDriveById(driveId);

    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    const isOwner = drive.ownerId === userId;
    let isAdmin = false;

    if (!isOwner) {
      const adminMembership = await driveInviteRepository.findAdminMembership(driveId, userId);
      isAdmin = adminMembership !== null;
    }

    if (!isOwner && !isAdmin) {
      return NextResponse.json({ error: 'Only drive owners and admins can add members' }, { status: 403 });
    }

    // Resolve email payload to a userId, branching to pending-invite path for new emails.
    let invitedUserId: string;
    let inviteKind: 'added' | 'invited' = 'added';
    let normalizedEmail: string | null = null;
    let pendingMagicToken: string | null = null;

    if (bodyEmail && !bodyUserId) {
      normalizedEmail = bodyEmail.toLowerCase().trim();

      const existingUser = await driveInviteRepository.findUserIdByEmail(normalizedEmail);
      if (existingUser) {
        invitedUserId = existingUser.id;
      } else {
        const pending = await driveInviteRepository.findActivePendingMemberByEmail(
          driveId,
          normalizedEmail
        );
        if (pending) {
          return NextResponse.json(
            { error: 'An invitation is already pending for this email', existingMemberId: pending.id },
            { status: 409 }
          );
        }

        const rateLimit = await checkDistributedRateLimit(
          `drive_invite:email:${normalizedEmail}`,
          DISTRIBUTED_RATE_LIMITS.MAGIC_LINK
        );
        if (!rateLimit.allowed) {
          return NextResponse.json(
            { error: 'Too many invitations sent to this email recently. Please try again later.' },
            {
              status: 429,
              headers: { 'Retry-After': String(rateLimit.retryAfter ?? 900) },
            }
          );
        }

        const tokenResult = await createMagicLinkToken({
          email: normalizedEmail,
          expiryMinutes: INVITATION_LINK_EXPIRY_MINUTES,
        });
        if (!tokenResult.ok) {
          loggers.api.error('Failed to create magic link token for invite', new Error(tokenResult.error.code));
          return NextResponse.json({ error: 'Failed to create invitation' }, { status: 500 });
        }
        invitedUserId = tokenResult.data.userId;
        pendingMagicToken = tokenResult.data.token;
        inviteKind = 'invited';
      }
    } else if (bodyUserId) {
      invitedUserId = bodyUserId;
    } else {
      return NextResponse.json(
        { error: 'Either userId or email is required' },
        { status: 400 }
      );
    }

    // Check if member already exists
    const existingMember = await driveInviteRepository.findExistingMember(driveId, invitedUserId);

    let memberId: string;

    if (!existingMember) {
      // Add as drive member with specified role; pending invites leave acceptedAt null
      const newMember = await driveInviteRepository.createDriveMember({
        driveId,
        userId: invitedUserId,
        role,
        customRoleId: customRoleId || null,
        invitedBy: userId,
        acceptedAt: inviteKind === 'invited' ? null : new Date(),
      });

      memberId = newMember.id;
    } else {
      // Update role if member exists
      await driveInviteRepository.updateDriveMemberRole(
        existingMember.id,
        role,
        customRoleId || null
      );

      memberId = existingMember.id;
    }

    // Broadcast member added/updated event to the affected user
    await broadcastDriveMemberEvent(
      createDriveMemberEventPayload(driveId, invitedUserId, 'member_added', {
        role,
        driveName: drive.name
      })
    );

    // Validate that all pageIds belong to this drive
    const validPageIds = new Set(await driveInviteRepository.getValidPageIds(driveId));

    // Add permissions for each page
    const permissionPromises = permissions.map(async (perm) => {
      if (!validPageIds.has(perm.pageId)) {
        loggers.api.warn(`Invalid page ID ${perm.pageId} for drive ${driveId}`);
        return null;
      }

      // Check if permission already exists
      const existing = await driveInviteRepository.findPagePermission(perm.pageId, invitedUserId);

      if (existing) {
        // Update existing permission
        return driveInviteRepository.updatePagePermission(existing.id, {
          canView: perm.canView,
          canEdit: perm.canEdit,
          canShare: perm.canShare,
          grantedBy: userId,
          grantedAt: new Date(),
        });
      } else {
        // Create new permission
        return driveInviteRepository.createPagePermission({
          pageId: perm.pageId,
          userId: invitedUserId,
          canView: perm.canView,
          canEdit: perm.canEdit,
          canShare: perm.canShare,
          canDelete: false, // Never grant delete via invite
          grantedBy: userId,
        });
      }
    });

    const results = await Promise.all(permissionPromises);
    const validResults = results.filter(r => r !== null);

    if (inviteKind === 'invited' && pendingMagicToken && normalizedEmail) {
      const appUrl =
        process.env.WEB_APP_URL ||
        process.env.NEXT_PUBLIC_APP_URL ||
        'http://localhost:3000';
      const magicLinkUrl = `${appUrl}/api/auth/magic-link/verify?token=${pendingMagicToken}&inviteDriveId=${driveId}`;
      const inviter = await driveInviteRepository.findInviterDisplay(userId);
      await sendPendingDriveInvitationEmail({
        recipientEmail: normalizedEmail,
        inviterName: inviter?.name || 'A PageSpace user',
        driveName: drive.name,
        magicLinkUrl,
      });
    } else {
      // Send notification to added existing user
      await createDriveNotification(
        invitedUserId,
        driveId,
        'invited', // Always use 'invited' which now has "added" language
        role,
        userId
      );
    }

    trackDriveOperation(userId, 'invite_member', driveId, {
      invitedUserId,
      role,
      permissionsGranted: validResults.length,
    });

    // Log activity for audit trail
    const actorInfo = await getActorInfo(userId);
    const invitedUserEmail = await driveInviteRepository.findUserEmail(invitedUserId);
    logMemberActivity(userId, 'member_add', {
      driveId,
      driveName: drive.name,
      targetUserId: invitedUserId,
      targetUserEmail: invitedUserEmail,
      role,
    }, actorInfo);

    auditRequest(request, { eventType: 'authz.permission.granted', userId, resourceType: 'drive', resourceId: driveId, details: { targetUserId: invitedUserId, role, operation: 'invite' } });

    return NextResponse.json({
      memberId,
      kind: inviteKind,
      ...(normalizedEmail ? { email: normalizedEmail } : {}),
      permissionsGranted: validResults.length,
      message: `User added with ${validResults.length} page permissions`,
    });
  } catch (error) {
    loggers.api.error('Error adding member:', error as Error);
    return NextResponse.json(
      { error: 'Failed to add member' },
      { status: 500 }
    );
  }
}
