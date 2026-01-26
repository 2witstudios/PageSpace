import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  loggers,
  checkDriveAccess,
  getDriveMemberDetails,
  getMemberPermissions,
  updateMemberRole,
  updateMemberPermissions,
  invalidateUserPermissions,
  invalidateDrivePermissions,
} from '@pagespace/lib/server';
import { createDriveNotification } from '@pagespace/lib';
import {
  broadcastDriveMemberEvent,
  createDriveMemberEventPayload,
  kickUserFromDrive,
  kickUserFromDriveActivity,
} from '@/lib/websocket';
import { getActorInfo, logMemberActivity, logPermissionActivity } from '@pagespace/lib/monitoring/activity-logger';
import { db, driveMembers, pagePermissions, pages, eq, and, inArray } from '@pagespace/db';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string; userId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const currentUserId = auth.userId;

    const { driveId, userId } = await context.params;

    // Check if user is owner or admin
    const access = await checkDriveAccess(driveId, currentUserId);

    if (!access.drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json({ error: 'Only drive owners and admins can manage member settings' }, { status: 403 });
    }

    // Get member details
    const memberData = await getDriveMemberDetails(driveId, userId);

    if (!memberData) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    const member = {
      ...memberData,
      drive: {
        id: driveId,
        name: access.drive.name,
        slug: access.drive.slug,
        ownerId: access.drive.ownerId,
      }
    };

    // Get current permissions for this member
    const permissions = await getMemberPermissions(driveId, userId);

    return NextResponse.json({
      member,
      permissions
    });
  } catch (error) {
    loggers.api.error('Error fetching member details:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch member details' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ driveId: string; userId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const currentUserId = auth.userId;

    const { driveId, userId } = await context.params;

    const body = await request.json();
    const { role, customRoleId, permissions } = body;

    if (!permissions || !Array.isArray(permissions)) {
      return NextResponse.json({ error: 'Invalid permissions data' }, { status: 400 });
    }

    if (role && !['MEMBER', 'ADMIN'].includes(role)) {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
    }

    // Check if user is owner or admin
    const access = await checkDriveAccess(driveId, currentUserId);

    if (!access.drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json({ error: 'Only drive owners and admins can manage member settings' }, { status: 403 });
    }

    // Verify member exists in drive
    const memberData = await getDriveMemberDetails(driveId, userId);

    if (!memberData) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    // Update role and customRoleId if provided
    const { oldRole } = await updateMemberRole(driveId, userId, role, customRoleId);

    // Send notification if role changed (boundary obligation)
    if (role && role !== oldRole) {
      await createDriveNotification(
        userId,
        driveId,
        'role_changed',
        role,
        currentUserId
      );

      // Broadcast role change event to the affected user
      await broadcastDriveMemberEvent(
        createDriveMemberEventPayload(driveId, userId, 'member_role_changed', {
          role,
          driveName: access.drive.name
        })
      );

      // Log activity for audit trail (role change is a critical security event)
      const actorInfo = await getActorInfo(currentUserId);
      logMemberActivity(currentUserId, 'member_role_change', {
        driveId,
        driveName: access.drive.name,
        targetUserId: userId,
        targetUserEmail: memberData.user?.email,
        role: role as string,
        previousRole: oldRole as string,
      }, actorInfo);
    }

    // Update permissions
    const permissionsUpdated = await updateMemberPermissions(
      driveId,
      userId,
      currentUserId,
      permissions
    );

    // Invalidate permission caches so changes take effect immediately
    await Promise.all([
      invalidateUserPermissions(userId),
      invalidateDrivePermissions(driveId),
    ]);

    return NextResponse.json({
      success: true,
      message: 'Permissions updated successfully',
      permissionsUpdated
    });
  } catch (error) {
    loggers.api.error('Error updating member permissions:', error as Error);
    return NextResponse.json(
      { error: 'Failed to update member permissions' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/drives/[driveId]/members/[userId]
 * Remove a member from the drive (kick)
 * This also removes all their page permissions within the drive
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ driveId: string; userId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const currentUserId = auth.userId;

    const { driveId, userId: targetUserId } = await context.params;

    // Check if current user is owner or admin
    const access = await checkDriveAccess(driveId, currentUserId);

    if (!access.drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json({ error: 'Only drive owners and admins can remove members' }, { status: 403 });
    }

    // Cannot remove the drive owner
    if (targetUserId === access.drive.ownerId) {
      return NextResponse.json({ error: 'Cannot remove the drive owner' }, { status: 400 });
    }

    // Cannot remove yourself (use leave drive instead)
    if (targetUserId === currentUserId) {
      return NextResponse.json({ error: 'Cannot remove yourself. Use leave drive instead.' }, { status: 400 });
    }

    // Verify member exists
    const memberData = await getDriveMemberDetails(driveId, targetUserId);
    if (!memberData) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    // Get actor info for logging
    const actorInfo = await getActorInfo(currentUserId);

    // Remove member and their permissions in a transaction
    // Fix 12: Log permissions BEFORE deletion for rollback support
    await db.transaction(async (tx) => {
      // Get all pages in this drive
      const drivePages = await tx.select({ id: pages.id, title: pages.title })
        .from(pages)
        .where(eq(pages.driveId, driveId));

      // Delete all pagePermissions for this user on these pages
      if (drivePages.length > 0) {
        const pageIds = drivePages.map(p => p.id);

        // Query existing permissions BEFORE deletion for rollback audit trail
        const existingPermissions = await tx.select({
          pageId: pagePermissions.pageId,
          canView: pagePermissions.canView,
          canEdit: pagePermissions.canEdit,
          canShare: pagePermissions.canShare,
          canDelete: pagePermissions.canDelete,
          grantedBy: pagePermissions.grantedBy,
          note: pagePermissions.note,
        })
          .from(pagePermissions)
          .where(and(
            inArray(pagePermissions.pageId, pageIds),
            eq(pagePermissions.userId, targetUserId)
          ));

        // Log each permission revocation with previousValues (fire-and-forget)
        const pageTitleMap = new Map(drivePages.map(p => [p.id, p.title]));
        for (const perm of existingPermissions) {
          logPermissionActivity(currentUserId, 'permission_revoke', {
            pageId: perm.pageId,
            driveId,
            targetUserId,
            pageTitle: pageTitleMap.get(perm.pageId) ?? undefined,
          }, {
            actorEmail: actorInfo.actorEmail,
            actorDisplayName: actorInfo.actorDisplayName,
            previousValues: {
              canView: perm.canView,
              canEdit: perm.canEdit,
              canShare: perm.canShare,
              canDelete: perm.canDelete,
              grantedBy: perm.grantedBy,
              note: perm.note,
            },
            reason: 'member_removal',
          });
        }

        // Delete the permissions
        await tx.delete(pagePermissions)
          .where(and(
            inArray(pagePermissions.pageId, pageIds),
            eq(pagePermissions.userId, targetUserId)
          ));
      }

      // Delete drive membership
      await tx.delete(driveMembers)
        .where(and(
          eq(driveMembers.driveId, driveId),
          eq(driveMembers.userId, targetUserId)
        ));
    });

    // Log member removal for audit trail (fire-and-forget)
    // Include full membership data for rollback support
    logMemberActivity(currentUserId, 'member_remove', {
      driveId,
      driveName: access.drive.name,
      targetUserId,
      targetUserEmail: memberData.user?.email,
      role: memberData.role,
      customRoleId: memberData.customRole?.id ?? null,
      invitedBy: memberData.invitedBy,
      invitedAt: memberData.invitedAt,
      acceptedAt: memberData.acceptedAt,
    }, actorInfo);

    // Broadcast member removal event
    await broadcastDriveMemberEvent(
      createDriveMemberEventPayload(driveId, targetUserId, 'member_removed', {
        driveName: access.drive.name,
      })
    );

    // CRITICAL: Kick user from real-time rooms immediately (zero-trust revocation)
    // This ensures the user stops receiving updates even if their socket is still connected
    await Promise.all([
      kickUserFromDrive(driveId, targetUserId, 'member_removed', access.drive.name),
      kickUserFromDriveActivity(driveId, targetUserId, 'member_removed'),
    ]);

    // Invalidate permission caches so removed user loses access immediately
    await Promise.all([
      invalidateUserPermissions(targetUserId),
      invalidateDrivePermissions(driveId),
    ]);

    // Note: No in-app notification sent for removal - the broadcast event
    // will trigger a page refresh/redirect for the removed user, and the
    // activity log provides an audit trail for compliance

    return NextResponse.json({
      success: true,
      message: 'Member removed successfully',
    });
  } catch (error) {
    loggers.api.error('Error removing member:', error as Error);
    return NextResponse.json(
      { error: 'Failed to remove member' },
      { status: 500 }
    );
  }
}
