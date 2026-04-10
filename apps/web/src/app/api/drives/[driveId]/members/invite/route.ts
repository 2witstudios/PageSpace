import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { createDriveNotification, isEmailVerified } from '@pagespace/lib';
import { loggers, securityAudit, invalidateUserPermissions, invalidateDrivePermissions } from '@pagespace/lib/server';
import { broadcastDriveMemberEvent, createDriveMemberEventPayload } from '@/lib/websocket';
import { getActorInfo, logMemberActivity } from '@pagespace/lib/monitoring/activity-logger';
import { trackDriveOperation } from '@pagespace/lib/activity-tracker';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';

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
    const { userId: invitedUserId, role = 'MEMBER', customRoleId, permissions } = body as {
      userId: string;
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

    // Check if member already exists
    const existingMember = await driveInviteRepository.findExistingMember(driveId, invitedUserId);

    let memberId: string;

    if (!existingMember) {
      // Add as drive member with specified role
      const newMember = await driveInviteRepository.createDriveMember({
        driveId,
        userId: invitedUserId,
        role,
        customRoleId: customRoleId || null,
        invitedBy: userId,
        acceptedAt: new Date(),
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

    // Invalidate permission caches so user immediately sees their new access
    await Promise.all([
      invalidateUserPermissions(invitedUserId),
      invalidateDrivePermissions(driveId),
    ]);

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

    // Send notification to added user
    await createDriveNotification(
      invitedUserId,
      driveId,
      'invited', // Always use 'invited' which now has "added" language
      role,
      userId
    );

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

    securityAudit.logEvent({ eventType: 'authz.permission.granted', userId, resourceType: 'drive', resourceId: driveId, details: { targetUserId: invitedUserId, role, operation: 'invite' } })?.catch(() => {});

    return NextResponse.json({
      memberId,
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
