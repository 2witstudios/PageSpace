import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { createDriveNotification } from '@pagespace/lib/notifications/notifications'
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { broadcastDriveMemberEventToRecipients, createDriveMemberEventPayload } from '@/lib/websocket';
import { getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';
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

export type InviteKind = 'added' | 'invited';
export interface InviteMemberResponse {
  memberId: string;
  kind: InviteKind;
  email?: string;
  permissionsGranted: number;
  message: string;
}

const emailSchema = z.string().email();

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
      permissions: rawPermissions,
    } = body as {
      userId?: string;
      email?: string;
      role?: 'MEMBER' | 'ADMIN';
      customRoleId?: string | null;
      permissions?: PermissionEntry[];
    };
    const permissions: PermissionEntry[] = Array.isArray(rawPermissions) ? rawPermissions : [];

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

      const emailParse = emailSchema.safeParse(normalizedEmail);
      if (!emailParse.success) {
        return NextResponse.json(
          { error: 'Invalid email address' },
          { status: 400 }
        );
      }

      // Reject re-invites of an email that already has a pending row in this drive,
      // regardless of whether the email currently maps to an existing user (e.g. a
      // temp user created by a prior invitation). The lookup joins users → members
      // by email, so it catches both the no-user-yet and pending-temp-user cases.
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

      const existingUser = await driveInviteRepository.findUserIdByEmail(normalizedEmail);
      if (existingUser) {
        invitedUserId = existingUser.id;
      } else {
        // Two complementary rate-limits guard the invitation email side-channel:
        //   - drive_invite:email:<email>: across-drives cap to prevent a single
        //     user-controlled email being bombarded by colluding drive owners.
        //   - drive_invite:drive:<driveId>:<email>: per-drive cap so an owner
        //     can't burn the global per-email budget by retrying within one drive.
        const [globalLimit, perDriveLimit] = await Promise.all([
          checkDistributedRateLimit(
            `drive_invite:email:${normalizedEmail}`,
            DISTRIBUTED_RATE_LIMITS.MAGIC_LINK
          ),
          checkDistributedRateLimit(
            `drive_invite:drive:${driveId}:${normalizedEmail}`,
            DISTRIBUTED_RATE_LIMITS.MAGIC_LINK
          ),
        ]);
        if (!globalLimit.allowed || !perDriveLimit.allowed) {
          const retryAfter = Math.max(
            globalLimit.retryAfter ?? 0,
            perDriveLimit.retryAfter ?? 0,
            900
          );
          return NextResponse.json(
            { error: 'Too many invitations sent to this email recently. Please try again later.' },
            {
              status: 429,
              headers: { 'Retry-After': String(retryAfter) },
            }
          );
        }

        const tokenResult = await createMagicLinkToken({
          email: normalizedEmail,
          expiryMinutes: INVITATION_LINK_EXPIRY_MINUTES,
        });
        if (!tokenResult.ok) {
          if (tokenResult.error.code === 'USER_SUSPENDED') {
            return NextResponse.json(
              { error: 'This account is suspended and cannot receive invitations.' },
              { status: 403 }
            );
          }
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
    // membershipBecameAccepted = TRUE only when this request transitioned the row
    // from no-membership or pending → accepted. Pure role-update on an
    // already-accepted member is NOT a join transition and must not re-emit
    // member_added or the invite-added notification.
    let membershipBecameAccepted = false;

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
      membershipBecameAccepted = inviteKind !== 'invited';
    } else {
      // Update role if member exists
      await driveInviteRepository.updateDriveMemberRole(
        existingMember.id,
        role,
        customRoleId || null
      );

      memberId = existingMember.id;
      // If the legacy userId path lands on a pending row, accept it now —
      // that IS a join transition. An already-accepted row is just a role update.
      // Email path can't reach this branch for pending rows (409 fires earlier).
      if (existingMember.acceptedAt === null && inviteKind === 'added') {
        membershipBecameAccepted = await driveInviteRepository.acceptPendingMember(existingMember.id);
      }
    }

    if (membershipBecameAccepted) {
      // Fan out to drive recipients (owner + accepted members) plus the invitee
      // so admins watching the members page see the new join in real time.
      const driveRecipients = await getDriveRecipientUserIds(driveId);
      await broadcastDriveMemberEventToRecipients(
        createDriveMemberEventPayload(driveId, invitedUserId, 'member_added', {
          role,
          driveName: drive.name
        }),
        driveRecipients
      );
    }

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
      const magicLinkUrl = `${appUrl}/api/auth/magic-link/verify?token=${encodeURIComponent(pendingMagicToken)}&inviteDriveId=${encodeURIComponent(driveId)}`;
      const inviter = await driveInviteRepository.findInviterDisplay(userId);
      await sendPendingDriveInvitationEmail({
        recipientEmail: normalizedEmail,
        inviterName: inviter?.name || 'A PageSpace user',
        driveName: drive.name,
        magicLinkUrl,
      });
    } else if (membershipBecameAccepted) {
      // Send "you've been added" notification only on a fresh join transition.
      // Pure role/permissions updates on already-accepted members must not retrigger it.
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
